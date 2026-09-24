import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommunicationsService } from '../communications/communications.service';
import { ClassesService } from '../classes/classes.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  MEMBER_NOTIFICATION_CATEGORIES,
  MEMBER_NOTIFICATION_CATEGORY_KEYS,
} from '../notifications/notification-categories';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.service';
import type { UpdatePortalProfileDto } from './dto/update-portal-profile.dto';
import type { ListPortalClassesDto } from './dto/portal-classes.dto';
import type { RequestRenewalDto } from './dto/request-renewal.dto';
import type { UpdateNotificationPreferencesDto } from '../notifications/dto/update-notification-preferences.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Marks a follow-up as having come from the member app, so a second
 * tap finds the first request instead of queueing another. */
const RENEWAL_FOLLOW_UP_PREFIX = 'Renewal requested: ';

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
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly classesService: ClassesService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The member behind a portal request. Throws rather than returning
   * null: every caller needs one, and a staff user reaching a `/portal`
   * route is a mistake worth surfacing rather than an empty result.
   */
  private async requireMember(userId: string) {
    const member = await this.prisma.member.findFirst({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        primaryBranchId: true,
        firstName: true,
      },
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
    // The account and the token are already committed, so a send that
    // fails must not fail the grant -- the member can still be given the
    // link another way. But it must not be reported as sent either:
    // `invited: true` regardless of what happened is how you get a gym
    // owner waiting on an email that was never going to arrive.
    const invited = await this.communications
      .sendMemberPortalInvite(
        organizationId,
        email,
        member.firstName,
        inviteToken,
        member.id,
      )
      .then(() => true)
      .catch((error: unknown) => {
        this.logger.error(
          `Portal invite for member ${member.id} could not be sent: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      });

    void actorUserId;
    return { memberId: member.id, userId: user, email, invited };
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
        // The editable set, so the account form can show what is
        // already on file. Without these it renders blanks over stored
        // values, and a member cannot tell an empty field from one the
        // screen simply did not fetch.
        emergencyContactName: true,
        emergencyContactPhone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
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

  // ---------------------------------------------------------------
  // Writes. Every one resolves the member from the caller's own JWT,
  // exactly as the reads do -- no route takes a member id, so there is
  // nothing to tamper with.
  // ---------------------------------------------------------------

  /**
   * The member's own contact details.
   *
   * The narrow DTO is the authorization: it cannot express a change to
   * status, branch, trainer, member type or anything about a
   * membership, so no filtering step has to remember to strip them.
   */
  async updateProfile(userId: string, dto: UpdatePortalProfileDto) {
    const { id } = await this.requireMember(userId);
    // `transform: true` hands over a class instance with every optional
    // property present and undefined, so counting keys would call an
    // empty body a five-field update -- and then write undefined over
    // nothing. Count what was actually sent.
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    await this.prisma.member.update({ where: { id }, data: changes });
    return this.me(userId);
  }

  /**
   * Notification preferences, as the member's own user.
   *
   * Delegates to the staff service rather than reimplementing: it
   * already validates the category against the catalogue, which is the
   * part that was wrong before B-P0-11 (an unknown category saved
   * happily, matched nothing, and the member kept being notified).
   */
  async notificationPreferences(userId: string) {
    const { organizationId } = await this.requireMember(userId);
    const stored = await this.notifications.getPreferences(
      userId,
      organizationId,
    );
    const byCategory = new Map(stored.map((row) => [row.category, row]));

    // A category with no row is on by default, so the portal shows the
    // effective setting rather than an empty list the member cannot act
    // on until something happens to write a row.
    //
    // Six of the ten, not all ten: the rest are staff categories, and
    // offering a member a switch for "low stock and inventory alerts" or
    // "new leads" is offering to mute messages they were never going to
    // get.
    return {
      items: MEMBER_NOTIFICATION_CATEGORIES.map((category) => {
        const row = byCategory.get(category.key);
        return {
          key: category.key,
          label: category.label,
          description: category.description,
          inApp: row?.inApp ?? true,
          email: row?.email ?? true,
          whatsapp: row?.whatsapp ?? true,
          sms: row?.sms ?? true,
          push: row?.push ?? true,
        };
      }),
    };
  }

  async updateNotificationPreference(
    userId: string,
    category: string,
    dto: UpdateNotificationPreferencesDto,
  ) {
    const { organizationId } = await this.requireMember(userId);
    // The staff service would happily store a preference for a staff
    // category. Refusing here keeps what a member can set equal to what
    // the portal offers them -- the B-P0-11 rule, applied to this
    // surface: a stored setting that changes nothing is worse than a
    // rejection.
    const normalized = category.trim().toUpperCase();
    if (!MEMBER_NOTIFICATION_CATEGORY_KEYS.includes(normalized)) {
      throw new BadRequestException(
        `Unknown notification category '${category}'. Expected one of: ${MEMBER_NOTIFICATION_CATEGORY_KEYS.join(', ')}.`,
      );
    }
    await this.notifications.updatePreferences(
      userId,
      organizationId,
      normalized,
      dto,
    );
    return this.notificationPreferences(userId);
  }

  /**
   * The timetable at the member's own branch, with their standing in
   * each session folded in -- a list of classes that does not say which
   * ones you are already in is a list you cannot act on.
   */
  async classes(userId: string, query: ListPortalClassesDto) {
    const { id, organizationId, primaryBranchId } =
      await this.requireMember(userId);

    const sessions = await this.classesService.sessions(organizationId, {
      from: query.from,
      to: query.to,
      // A member sees their own branch's timetable, not the whole
      // organization's. Passing the branch through the shared listing
      // keeps one definition of "which sessions are in this window".
      ...(primaryBranchId ? { branchId: primaryBranchId } : {}),
    });
    if (sessions.length === 0) return { items: [] };

    const mine = await this.prisma.classBooking.findMany({
      where: {
        memberId: id,
        sessionId: { in: sessions.map((session) => session.id) },
        status: { in: ['BOOKED', 'WAITLISTED'] },
      },
      select: {
        id: true,
        sessionId: true,
        status: true,
        waitlistPosition: true,
      },
    });
    const bySession = new Map(mine.map((row) => [row.sessionId, row]));

    return {
      items: sessions.map((session) => {
        const booking = bySession.get(session.id);
        return {
          ...session,
          myBookingId: booking?.id ?? null,
          myBookingStatus: booking?.status ?? null,
          myWaitlistPosition: booking?.waitlistPosition ?? null,
        };
      }),
    };
  }

  async bookClass(userId: string, sessionId: string) {
    const { id, organizationId } = await this.requireMember(userId);
    return this.classesService.book(organizationId, sessionId, id);
  }

  /**
   * Cancelling is the one place the shared service is not enough.
   * `ClassesService.cancel` checks only that the booking belongs to the
   * organization, which is right for a receptionist cancelling on
   * someone's behalf and wrong here -- it would let any member cancel
   * any other member's seat. So ownership is established first, from
   * the JWT, and only then is the shared cancel (with its advisory lock
   * and waitlist promotion) allowed to run.
   */
  async cancelClassBooking(userId: string, bookingId: string) {
    const { id, organizationId } = await this.requireMember(userId);
    const booking = await this.prisma.classBooking.findFirst({
      where: { id: bookingId, organizationId, memberId: id },
      select: { id: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return this.classesService.cancel(organizationId, bookingId);
  }

  /**
   * What the member could renew onto: the plans their branch offers,
   * priced from the plan row.
   */
  async renewalOptions(userId: string) {
    const { organizationId, primaryBranchId } =
      await this.requireMember(userId);
    const items = await this.prisma.membershipPlan.findMany({
      where: {
        organizationId,
        isActive: true,
        // A null branchId on a plan means "every branch".
        OR: [{ branchId: null }, { branchId: primaryBranchId }],
      },
      orderBy: { price: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        durationDays: true,
        price: true,
        currency: true,
        benefits: true,
      },
    });
    return { items };
  }

  /**
   * A member asking their gym to renew them.
   *
   * Deliberately not a payment. Taking money needs a gateway that is
   * actually configured and a webhook that is actually reachable, and
   * shipping a "Pay now" button that silently does neither would be
   * worse than no button. What this does is put the request somewhere
   * staff already look: a `MemberFollowUp`, the same queue the renewal
   * reminders feed.
   *
   * Priced from the plan row, never from the request body -- the shape
   * that matters whenever the payment half does land.
   */
  async requestRenewal(userId: string, dto: RequestRenewalDto) {
    const { id, organizationId, primaryBranchId, firstName } =
      await this.requireMember(userId);

    const plan = await this.prisma.membershipPlan.findFirst({
      where: {
        id: dto.membershipPlanId,
        organizationId,
        isActive: true,
        OR: [{ branchId: null }, { branchId: primaryBranchId }],
      },
      select: { id: true, name: true, price: true, currency: true },
    });
    if (!plan) {
      throw new NotFoundException('That plan is not available at your branch');
    }

    // One open request at a time. Without this, a member tapping twice
    // on a slow connection puts two identical items in the gym's queue.
    const existing = await this.prisma.memberFollowUp.findFirst({
      where: {
        organizationId,
        memberId: id,
        completedAt: null,
        title: { startsWith: RENEWAL_FOLLOW_UP_PREFIX },
      },
      select: { id: true, createdAt: true },
    });
    if (existing) {
      return { requestId: existing.id, plan, alreadyRequested: true };
    }

    const followUp = await this.prisma.memberFollowUp.create({
      data: {
        organizationId,
        memberId: id,
        title: `${RENEWAL_FOLLOW_UP_PREFIX}${plan.name}`,
        description: [
          `${firstName} asked to renew onto ${plan.name} (${plan.currency} ${plan.price.toString()}) from the member app.`,
          dto.note?.trim() ? `Their note: ${dto.note.trim()}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        priority: 'HIGH',
        dueAt: new Date(),
      },
      select: { id: true },
    });

    return { requestId: followUp.id, plan, alreadyRequested: false };
  }
}
