import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.service';
import { MailerService } from '../common/mailer/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AssignRoleDto } from './dto/assign-role.dto';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    branchScope: string | null = null,
  ) {
    const where = {
      organizationId,
      deletedAt: null,
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

  async invite(
    organizationId: string,
    dto: CreateUserDto,
    branchScope: string | null = null,
  ) {
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

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing)
      throw new ConflictException('An account with this email already exists');

    const role = await this.resolveRole(organizationId, dto.roleKey);
    if (!role) throw new BadRequestException(`Unknown role: ${dto.roleKey}`);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          organizationId,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          primaryBranchId: dto.primaryBranchId,
          status: 'INVITED',
        },
      });

      await tx.staffProfile.create({
        data: {
          userId: created.id,
          organizationId,
          branchId: dto.primaryBranchId,
          jobTitle: dto.jobTitle,
          isTrainer: dto.isTrainer ?? false,
          specializations: dto.specializations ?? [],
          bio: dto.bio,
          commissionRate: dto.commissionRate,
          employeeCode: dto.employeeCode,
          hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
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

    const inviteToken = generateOpaqueToken();
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(inviteToken),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await this.mailer.sendPasswordReset(user.email, inviteToken);

    return this.getOne(organizationId, user.id);
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateUserDto,
    branchScope: string | null = null,
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
    const { jobTitle, isTrainer, specializations, bio, ...userFields } = dto;

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: userFields }),
      this.prisma.staffProfile.updateMany({
        where: { userId: id },
        data: { jobTitle, isTrainer, specializations, bio },
      }),
    ]);
    return this.getOne(organizationId, id);
  }

  async deactivate(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope);
    return this.prisma.user.update({
      where: { id },
      data: { status: 'DISABLED', deletedAt: new Date() },
    });
  }

  async assignRole(
    organizationId: string,
    userId: string,
    dto: AssignRoleDto,
    branchScope: string | null = null,
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
      actorUserId: userId,
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
  ) {
    await this.getOne(organizationId, userId, branchScope);
    const userRole = await this.prisma.userRole.findFirst({
      where: { id: userRoleId, userId, organizationId },
    });
    if (!userRole) throw new NotFoundException('Role assignment not found');
    // A branch-scoped revoker can only touch grants scoped to their own
    // branch -- not an org-wide grant or one for a different branch.
    if (branchScope && userRole.branchId !== branchScope) {
      throw new NotFoundException('Role assignment not found');
    }
    await this.prisma.userRole.delete({ where: { id: userRoleId } });
    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'revoke_role',
      resource: 'user',
      resourceId: userId,
      beforeState: { userRoleId },
    });
  }

  private async resolveRole(organizationId: string, roleKey: string) {
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

function sanitize<T extends { passwordHash?: string | null }>(
  user: T,
): Omit<T, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}
