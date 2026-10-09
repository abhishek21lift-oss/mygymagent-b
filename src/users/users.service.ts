import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import {
  endAllSessions,
  generateOpaqueToken,
  hashOpaqueToken,
} from '../auth/tokens.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { assertPayrollSettings } from '../hr-payroll/hr-payroll.service';
import { PermissionsService } from '../rbac/permissions.service';
import { PLATFORM_ONLY_ROLE_KEYS } from '../rbac/roles.catalog';
import type { AssignRoleDto } from './dto/assign-role.dto';
import type {
  CreateUserDto,
  StaffAccess,
  StaffPayDto,
} from './dto/create-user.dto';
import type { GrantAccessDto } from './dto/grant-access.dto';
import type { UpdateUserDto } from './dto/update-user.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The role that owns an organization. */
const OWNER_ROLE_KEY = 'ORG_OWNER';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly billing: PlatformBillingService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    branchScope: string | null = null,
  ) {
    const where = {
      organizationId,
      deletedAt: null,
      // Staff only: a member's portal login is a user too.
      member: { is: null },
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(query.search
        ? {
            OR: [
              {
                firstName: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                lastName: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                email: { contains: query.search, mode: 'insensitive' as const },
              },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: { staffProfile: true, userRoles: { include: { role: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(items.map(sanitize), total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      include: { staffProfile: true, userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return sanitize(user);
  }

  /**
   * Adds a staff member. `access` decides how they get into the app -- see
   * STAFF_ACCESS. The method keeps its old name: `POST /users` without
   * `access` is still exactly the email invite it always was.
   */
  async invite(
    organizationId: string,
    dto: CreateUserDto,
    branchScope: string | null = null,
    actorId: string | null = null,
  ) {
    const access: StaffAccess = dto.access ?? 'INVITE';
    if (access === 'NONE' && dto.email) {
      throw new BadRequestException(
        'Leave the email out for staff without app access -- add it when you give them access',
      );
    }
    if (access !== 'NONE' && !dto.email) {
      throw new BadRequestException('An email is needed to sign in');
    }
    if (branchScope && dto.primaryBranchId !== branchScope) {
      throw new BadRequestException(
        'Cannot invite a staff member outside your assigned branch',
      );
    }
    // A branch-scoped inviter can't hand out an org-wide grant, or a grant
    // scoped to a branch other than their own -- either would let them
    // escalate someone past their own access level.
    if (branchScope && (dto.roleBranchId ?? null) !== branchScope) {
      throw new BadRequestException(
        'Cannot grant a role outside your assigned branch',
      );
    }
    // Both ids come from the request: without this, another gym's branch
    // could be written onto the staff member and their grant.
    if (dto.primaryBranchId) {
      await this.assertOwnBranch(organizationId, dto.primaryBranchId);
    }
    if (dto.roleBranchId) {
      await this.assertOwnBranch(organizationId, dto.roleBranchId);
    }

    await this.billing.assertUnder(organizationId, 'staff');

    if (dto.email) {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existing)
        throw new ConflictException(
          'An account with this email already exists',
        );
    }

    const role = await this.resolveRole(organizationId, dto.roleKey);
    if (!role) throw new BadRequestException(`Unknown role: ${dto.roleKey}`);
    // The same rule as assignRole(): only an owner makes an owner.
    if (role.key === OWNER_ROLE_KEY && !(await this.isOwner(actorId))) {
      throw new ForbiddenException('Only an owner can make someone an owner');
    }

    const pay = await this.resolvePay(
      organizationId,
      dto.pay,
      actorId,
      dto.primaryBranchId,
    );
    const passwordHash =
      access === 'PASSWORD' ? await argon2.hash(dto.password!) : null;

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          organizationId,
          email: dto.email ?? null,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          phone: dto.phone?.trim() || null,
          primaryBranchId: dto.primaryBranchId,
          // Only an emailed invite waits on the staff member. The others
          // are on the team from now: payroll, attendance and PT all see
          // them straight away.
          status: access === 'INVITE' ? 'INVITED' : 'ACTIVE',
          passwordHash,
        },
      });

      await tx.staffProfile.create({
        data: {
          userId: created.id,
          organizationId,
          branchId: dto.primaryBranchId,
          jobTitle: dto.jobTitle?.trim() || null,
          isTrainer: dto.isTrainer ?? false,
          specializations: dto.specializations ?? [],
          bio: dto.bio,
          commissionRate: dto.commissionRate,
          employeeCode: dto.employeeCode?.trim() || null,
          hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
          ...pay,
        },
      });

      await tx.userRole.create({
        data: {
          userId: created.id,
          roleId: role.id,
          organizationId,
          branchId: dto.roleBranchId ?? null,
        },
      });

      return created;
    });

    if (access === 'INVITE') await this.sendInvite(organizationId, user);

    return this.getOne(organizationId, user.id);
  }

  /**
   * Emails a staff member the link to set their password: a first invite
   * for someone added without app access, or a fresh one when the last
   * expired or went astray. Earlier unused links stop working.
   */
  async grantAccess(
    organizationId: string,
    id: string,
    dto: GrantAccessDto,
    branchScope: string | null = null,
    actorId: string | null = null,
  ) {
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        organizationId,
        deletedAt: null,
        member: { is: null },
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        status: true,
        passwordHash: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    await this.assertMayManage(organizationId, actorId, id);
    if (user.status !== 'INVITED' && user.status !== 'ACTIVE') {
      throw new BadRequestException(
        'This account is switched off. Reactivate it first.',
      );
    }
    if (user.passwordHash) {
      throw new ConflictException(
        'This staff member can already sign in. They can use "Forgot password" if they need a new one.',
      );
    }

    const email = dto.email ?? user.email;
    if (!email) {
      throw new BadRequestException('Add an email to send the invite to');
    }
    if (email !== user.email) {
      const taken = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { email } }),
      this.prisma.passwordResetToken.deleteMany({
        where: { userId: id, usedAt: null },
      }),
    ]);
    await this.sendInvite(organizationId, {
      id,
      email,
      firstName: user.firstName,
    });
    return this.getOne(organizationId, id);
  }

  /** Head counts for the staff page, within the caller's branch. */
  async stats(organizationId: string, branchScope: string | null = null) {
    const where: Prisma.UserWhereInput = {
      organizationId,
      deletedAt: null,
      member: { is: null },
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
    };
    const [total, active, invited, noAccess, trainers] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({
        where: { ...where, status: 'ACTIVE', passwordHash: { not: null } },
      }),
      this.prisma.user.count({
        where: {
          ...where,
          OR: [
            { status: 'INVITED' },
            { status: 'ACTIVE', passwordHash: null, email: { not: null } },
          ],
        },
      }),
      this.prisma.user.count({
        where: { ...where, status: 'ACTIVE', email: null },
      }),
      this.prisma.user.count({
        where: { ...where, staffProfile: { is: { isTrainer: true } } },
      }),
    ]);
    return { total, active, invited, noAccess, trainers };
  }

  /** A single-use link to set a password, valid for a week. */
  private async sendInvite(
    organizationId: string,
    user: { id: string; email: string | null; firstName: string },
  ) {
    const inviteToken = generateOpaqueToken();
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(inviteToken),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await this.communications
      .sendStaffInvite(
        organizationId,
        user.email ?? '',
        user.firstName,
        inviteToken,
      )
      .catch(() => undefined); // best-effort, matches the old MailerService's fire-and-forget shape -- see CommunicationsService's class comment
  }

  /**
   * Pay settings given with a new staff member. Salaries are `hr.manage`'s
   * (see HrPayrollController), not `users.create`'s, so a caller without it
   * is refused rather than having the pay silently dropped.
   */
  private async resolvePay(
    organizationId: string,
    pay: StaffPayDto | undefined,
    actorId: string | null,
    branchId: string | undefined,
  ) {
    if (!pay) return {};
    const allowed =
      actorId !== null &&
      (await this.permissions.hasPermission(
        actorId,
        organizationId,
        'hr.manage',
        branchId,
      ));
    if (!allowed) {
      throw new ForbiddenException('You do not have permission to set pay');
    }
    const settings = {
      payrollEnabled: pay.payrollEnabled ?? true,
      salaryType: pay.salaryType,
      baseSalary:
        pay.baseSalary !== undefined
          ? new Prisma.Decimal(pay.baseSalary)
          : null,
      hourlyRate:
        pay.hourlyRate !== undefined
          ? new Prisma.Decimal(pay.hourlyRate)
          : null,
    };
    assertPayrollSettings(settings);
    return settings;
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateUserDto,
    branchScope: string | null = null,
    actorId: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope);
    if (
      branchScope &&
      dto.primaryBranchId !== undefined &&
      dto.primaryBranchId !== branchScope
    ) {
      throw new BadRequestException(
        'Cannot move a staff member outside your assigned branch',
      );
    }
    await this.assertMayManage(organizationId, actorId, id);
    if (dto.primaryBranchId !== undefined) {
      await this.assertOwnBranch(organizationId, dto.primaryBranchId);
    }
    if (dto.status !== undefined && dto.status !== 'ACTIVE') {
      await this.assertNotLastOwner(organizationId, id);
    }
    const {
      jobTitle,
      isTrainer,
      specializations,
      bio,
      commissionRate,
      ...userFields
    } = dto;

    // Switching an account off ends its sessions: without this its refresh
    // tokens would come back to life the day it is reactivated.
    const switchingOff = dto.status !== undefined && dto.status !== 'ACTIVE';
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: userFields });
      if (switchingOff) await endAllSessions(tx, id);
      await tx.staffProfile.updateMany({
        where: { userId: id },
        data: {
          jobTitle,
          isTrainer,
          specializations,
          bio,
          commissionRate,
          // The profile's branch is the one payroll and HR filter by; it
          // stayed behind when the staff member moved.
          ...(dto.primaryBranchId !== undefined
            ? { branchId: dto.primaryBranchId }
            : {}),
        },
      });
    });
    return this.getOne(organizationId, id);
  }

  async deactivate(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    actorId: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope);
    await this.assertMayManage(organizationId, actorId, id);
    await this.assertNotLastOwner(organizationId, id);
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { status: 'DISABLED', deletedAt: new Date() },
      });
      await endAllSessions(tx, id);
      return updated;
    });
    // The raw row carried the argon2 password hash into the response.
    return sanitize(user);
  }

  async assignRole(
    organizationId: string,
    userId: string,
    dto: AssignRoleDto,
    branchScope: string | null = null,
    actorId: string | null = null,
  ) {
    await this.getOne(organizationId, userId, branchScope);
    // Same escalation guard as invite(): a branch-scoped grantor can only
    // hand out grants scoped to their own branch, never org-wide or to a
    // different branch.
    if (branchScope && (dto.branchId ?? null) !== branchScope) {
      throw new BadRequestException(
        'Cannot grant a role outside your assigned branch',
      );
    }
    const role = await this.resolveRole(organizationId, dto.roleKey);
    if (!role) throw new BadRequestException(`Unknown role: ${dto.roleKey}`);
    await this.assertMayManage(organizationId, actorId, userId);
    // Ownership is handed on only by an owner: an admin could otherwise
    // make themselves one, then remove the real owner.
    if (role.key === OWNER_ROLE_KEY && !(await this.isOwner(actorId))) {
      throw new ForbiddenException('Only an owner can make someone an owner');
    }
    if (dto.branchId) await this.assertOwnBranch(organizationId, dto.branchId);

    // Prisma rejects an explicit null inside a compound-unique `where`
    // selector, so a nullable branchId (org-wide grant) can't use upsert's
    // composite key -- fall back to findFirst + create.
    const branchId = dto.branchId ?? null;
    const existingGrant = await this.prisma.userRole.findFirst({
      where: { userId, roleId: role.id, branchId },
    });
    const userRole =
      existingGrant ??
      (await this.prisma.userRole.create({
        data: { userId, roleId: role.id, organizationId, branchId },
      }));

    await this.audit.record({
      organizationId,
      // The person who did it, not the person it was done to.
      actorUserId: actorId ?? userId,
      action: 'assign_role',
      resource: 'user',
      resourceId: userId,
      afterState: { roleKey: dto.roleKey, branchId: dto.branchId ?? null },
    });

    return userRole;
  }

  async revokeRole(
    organizationId: string,
    userId: string,
    userRoleId: string,
    branchScope: string | null = null,
    actorId: string | null = null,
  ) {
    await this.getOne(organizationId, userId, branchScope);
    await this.assertMayManage(organizationId, actorId, userId);
    const userRole = await this.prisma.userRole.findFirst({
      where: { id: userRoleId, userId, organizationId },
      include: { role: { select: { key: true } } },
    });
    if (!userRole) throw new NotFoundException('Role assignment not found');
    // A branch-scoped revoker can only touch grants scoped to their own
    // branch -- not an org-wide grant or one for a different branch.
    if (branchScope && userRole.branchId !== branchScope) {
      throw new NotFoundException('Role assignment not found');
    }
    if (userRole.role.key === OWNER_ROLE_KEY) {
      await this.assertNotLastOwner(organizationId, userId);
    }
    await this.prisma.userRole.delete({ where: { id: userRoleId } });
    await this.audit.record({
      organizationId,
      actorUserId: actorId ?? userId,
      action: 'revoke_role',
      resource: 'user',
      resourceId: userId,
      beforeState: { userRoleId },
    });
  }

  /** Whether this user holds the owner role. */
  private async isOwner(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const grant = await this.prisma.userRole.findFirst({
      where: { userId, role: { key: OWNER_ROLE_KEY } },
      select: { id: true },
    });
    return grant !== null;
  }

  /**
   * An owner's account is changed only by an owner.
   *
   * `users.update`, `users.delete` and `users.manage_roles` are all held
   * by ORG_ADMIN, so an admin could suspend the owner, strip their role or
   * point their account at another branch -- taking the gym from the
   * person who owns it. A user may still edit their own account.
   */
  private async assertMayManage(
    organizationId: string,
    actorId: string | null,
    targetId: string,
  ): Promise<void> {
    if (!actorId || actorId === targetId) return;
    const targetIsOwner = await this.prisma.userRole.findFirst({
      where: {
        userId: targetId,
        organizationId,
        role: { key: OWNER_ROLE_KEY },
      },
      select: { id: true },
    });
    if (targetIsOwner && !(await this.isOwner(actorId))) {
      throw new ForbiddenException(
        "Only an owner can change an owner's account",
      );
    }
  }

  /** An organization always keeps one active owner: without one nobody can
   * manage billing, roles or the account itself. */
  private async assertNotLastOwner(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const owners = await this.prisma.userRole.findMany({
      where: {
        organizationId,
        role: { key: OWNER_ROLE_KEY },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: { userId: true },
    });
    const ownerIds = new Set(owners.map((o) => o.userId));
    if (ownerIds.has(userId) && ownerIds.size === 1) {
      throw new BadRequestException(
        'This is the only owner. Make someone else an owner first.',
      );
    }
  }

  /** A branch id from the request must be one of this organization's. */
  private async assertOwnBranch(
    organizationId: string,
    branchId: string,
  ): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new BadRequestException('Branch not found');
  }

  private async resolveRole(organizationId: string, roleKey: string) {
    // The platform roles live in the same global catalogue as every other
    // role, so without this an organization admin could hand one out.
    // Platform routes are gated on User.platformRole rather than on an RBAC
    // grant, so it would confer nothing a platform role implies -- it would
    // only grant every ordinary permission under a name that reads as much
    // more than that to anyone auditing the staff list.
    if ((PLATFORM_ONLY_ROLE_KEYS as readonly string[]).includes(roleKey)) {
      return null;
    }
    return (
      (await this.prisma.role.findFirst({
        where: { organizationId, key: roleKey },
      })) ??
      (await this.prisma.role.findFirst({
        where: { organizationId: null, key: roleKey },
      }))
    );
  }
}

/** Drops the hash; says only whether there is one, which is what tells
 * a staff member who can sign in from one who hasn't set a password. */
function sanitize<T extends { passwordHash?: string | null }>(
  user: T,
): Omit<T, 'passwordHash'> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}
