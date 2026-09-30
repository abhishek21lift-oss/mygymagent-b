import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { MemberPushService } from '../../notifications/push/member-push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { runningOrganization, readableDate } from '../automation-scope';
import { MemberMessenger } from '../member-messenger.service';

const REMINDER_WINDOW_DAYS = 7;
const COOLDOWN_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Days-before-expiry on which the member's phone is nudged. A push is
 * cheaper to ignore than an email, so it goes at a week, then closer in. */
const PUSH_ON_DAYS = new Set([7, 3, 1]);

/**
 * Trigger: an ACTIVE membership's `endDate` falls within the next
 * `REMINDER_WINDOW_DAYS`. Conditions: not already reminded for this
 * membership in the last `COOLDOWN_DAYS` (AutomationRunService.attempt's
 * cooldown check). Action: `CommunicationsService.sendMembershipRenewalReminder`.
 * No approval step -- a TRANSACTIONAL reminder about the recipient's own
 * membership, the same risk tier as the existing password-reset email.
 */
@Injectable()
export class MembershipRenewalScanner {
  private readonly logger = new Logger(MembershipRenewalScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly messenger: MemberMessenger,
    private readonly memberPush: MemberPushService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + REMINDER_WINDOW_DAYS * MS_PER_DAY,
    );

    const memberships = await this.prisma.membership.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { gte: now, lte: windowEnd },
        member: { deletedAt: null },
        organization: runningOrganization,
      },
      include: {
        member: {
          select: {
            id: true,
            email: true,
            phone: true,
            firstName: true,
            // A membership that ends while a later one is already sold
            // is not lapsing: the member has renewed.
            memberships: {
              where: { status: { in: ['ACTIVE', 'PENDING', 'FROZEN'] } },
              select: { id: true, endDate: true },
            },
          },
        },
        membershipPlan: { select: { name: true } },
        organization: { select: { timezone: true } },
      },
    });

    let sent = 0;
    let checked = 0;
    for (const membership of memberships) {
      const renewed = membership.member.memberships.some(
        (other) =>
          other.id !== membership.id && other.endDate > membership.endDate,
      );
      if (renewed) continue;
      checked++;
      const daysUntilExpiry = Math.ceil(
        (membership.endDate.getTime() - now.getTime()) / MS_PER_DAY,
      );
      // Before the email check: a member who signs in by SMS has no
      // email on file and, until push, was never reminded at all.
      if (PUSH_ON_DAYS.has(daysUntilExpiry)) {
        await this.memberPush.notifyMember(
          membership.organizationId,
          membership.member.id,
          {
            type: 'MEMBERSHIP_EXPIRING',
            category: 'MEMBERSHIPS',
            title:
              daysUntilExpiry === 1
                ? 'Your membership ends tomorrow'
                : `Your membership ends in ${daysUntilExpiry} days`,
            body: `Renew ${membership.membershipPlan.name} to keep training without a break.`,
            actionUrl: '/portal/renew',
            dedupeKey: `membership-expiring:${membership.id}:${daysUntilExpiry}`,
          },
        );
      }
      const expiryDate = readableDate(
        membership.endDate,
        membership.organization.timezone,
      );
      // WhatsApp goes three times -- a week out, three days out, the last
      // day -- each once; email keeps its 3-day cooldown.
      const stage =
        daysUntilExpiry > 3 ? 't7' : daysUntilExpiry > 1 ? 't3' : 't0';
      const { outcome } = await this.messenger.deliver({
        organizationId: membership.organizationId,
        key: 'MEMBERSHIP_RENEWAL_REMINDER',
        subjectId: membership.id,
        cooldownDays: COOLDOWN_DAYS,
        member: membership.member,
        whatsapp: {
          templateKey: `renewal.${stage}`,
          stage,
          cooldownDays: 30,
          variables: {
            '1': membership.member.firstName,
            '2': membership.membershipPlan.name,
            '3': expiryDate,
          },
        },
        email: () =>
          this.communications.sendMembershipRenewalReminder(
            membership.organizationId,
            membership.member.id,
            membership.member.email || '',
            {
              firstName: membership.member.firstName,
              planName: membership.membershipPlan.name,
              expiryDate,
            },
          ),
        detail: { daysUntilExpiry },
      });
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Membership renewal scan: ${checked} lapsing in window, ${sent} reminders sent`,
    );
    return { checked, sent };
  }
}
