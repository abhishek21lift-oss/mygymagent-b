import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommunicationsService } from '../communications/communications.service';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Everything a member can see about themselves, and nothing else.
 *
 * F-P0-1. The portal is a separate surface from the staff API on
 * purpose, and the reason is a hole this work found: the `MEMBER` role
 * carried `attendance.read`, `workouts.read` and `nutrition.read` --
 * the *org-wide* read permissions that `GET /attendance` and friends
 * accept. A member holding that role could have listed every check-in
 * in the gym. Nothing ever issued it, which is the only reason it was
 * not a live breach.
 *
 * So no route here takes a memberId, and none declares a permission.
 * The member is resolved from the caller's own JWT through
 * `Member.userId`, and every query is scoped to that id. "Their own
 * data" is a property of the query, not of a grant someone might widen
 * later by editing a role.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
  ) {}

  /**
   * The member behind a portal request. Throws rather than returning
   * null: every caller needs one, and a staff user reaching a `/portal`
   * route is a mistake worth surfacing rather than an empty result.
   */
  private async requireMember(userId: string) {
    const member = await this.prisma.member.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!member) {
      throw new ForbiddenException(
        'This account is not linked to a gym member',
      );
    }
    return member;
  }

  /**
   * Grants a member portal login (staff-side, `portal.manage`).
   *
   * Reuses the staff credential lifecycle rather than inventing a second
   * one: a linked `User` carrying the MEMBER role, plus the same
   * password-reset token the staff invite uses. Members then sign in
   * through `POST /auth/login` like anyone else. The alternative -- a
   * parallel member-credential table -- would have meant a second
   * password hash, a second lockout policy and a second reset flow to
   * keep correct.
   */
  async enablePortalLogin(
    organizationId: string,
    actorUserId: string,
    memberId: string,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        userId: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.email) {
      throw new BadRequestException(
        'This member has no email address, so there is nowhere to send the portal invitation',
      );
    }

    const role = await this.prisma.role.findFirst({
      where: { key: 'MEMBER', OR: [{ organizationId }, { isSystem: true }] },
      select: { id: true },
    });
    if (!role) throw new BadRequestException('MEMBER role is not seeded');

    const email = member.email.toLowerCase();
    const clash = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (clash && clash.id !== member.userId) {
      throw new BadRequestException(
        'That email already belongs to another account on this platform',
      );
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const linked =
        member.userId ??
        (
          await tx.user.create({
            data: {
              organizationId,
              email,
              firstName: member.firstName,
              lastName: member.lastName ?? '',
              status: 'INVITED',
            },
            select: { id: true },
          })
        ).id;

      await tx.member.update({
        where: { id: member.id },
        data: { userId: linked },
      });

      // Idempotent: re-inviting a member must not stack roles.
      const existingRole = await tx.userRole.findFirst({
        where: { userId: linked, roleId: role.id, organizationId },
        select: { id: true },
      });
      if (!existingRole) {
        await tx.userRole.create({
          data: { userId: linked, roleId: role.id, organizationId },
        });
      }
      return linked;
    });

    const inviteToken = generateOpaqueToken();
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user,
        tokenHash: hashOpaqueToken(inviteToken),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await this.communications
      .sendStaffInvite(organizationId, email, member.firstName, inviteToken)
      .catch(() => undefined); // best-effort, as the staff invite is

    void actorUserId;
    return { memberId: member.id, userId: user, email, invited: true };
  }

  async me(userId: string) {
    const { id } = await this.requireMember(userId);
    const member = await this.prisma.member.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        memberCode: true,
        status: true,
        primaryBranch: { select: { id: true, name: true } },
        assignedTrainer: { select: { firstName: true, lastName: true } },
      },
    });

    const now = new Date();
    const activeMembership = await this.prisma.membership.findFirst({
      where: { memberId: id, status: 'ACTIVE', endDate: { gte: now } },
      orderBy: { endDate: 'desc' },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        status: true,
        membershipPlan: { select: { name: true } },
      },
    });

    return { member, activeMembership };
  }

  async memberships(userId: string) {
    const { id } = await this.requireMember(userId);
    const items = await this.prisma.membership.findMany({
      where: { memberId: id },
      orderBy: { startDate: 'desc' },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        price: true,
        currency: true,
        membershipPlan: { select: { name: true, durationDays: true } },
      },
    });
    return { items };
  }

  async attendance(userId: string, limit = 30) {
    const { id } = await this.requireMember(userId);
    const items = await this.prisma.attendance.findMany({
      where: { memberId: id },
      orderBy: { checkInAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        checkInAt: true,
        checkOutAt: true,
        method: true,
        deniedReason: true,
        branch: { select: { name: true } },
      },
    });
    return { items };
  }

  async workouts(userId: string) {
    const { id } = await this.requireMember(userId);
    const items = await this.prisma.workoutAssignment.findMany({
      where: { memberId: id },
      orderBy: { startDate: 'desc' },
      take: 20,
      select: {
        id: true,
        startDate: true,
        status: true,
        notes: true,
        // `exercises` is a Json column on the plan, not a relation -- the
        // shape is whatever the staff-side builder wrote, so it is passed
        // through as-is rather than reshaped here.
        workoutPlan: {
          select: { name: true, description: true, exercises: true },
        },
      },
    });
    return { items };
  }

  async nutrition(userId: string) {
    const { id } = await this.requireMember(userId);
    const items = await this.prisma.dietAssignment.findMany({
      where: { memberId: id },
      orderBy: { startDate: 'desc' },
      take: 20,
      select: {
        id: true,
        startDate: true,
        status: true,
        dietPlan: {
          select: {
            name: true,
            description: true,
            targetCalories: true,
            targetProteinG: true,
            items: true,
          },
        },
      },
    });
    return { items };
  }
}
