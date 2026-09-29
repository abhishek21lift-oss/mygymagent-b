import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { MemberPushService } from '../../notifications/push/member-push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

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
    private readonly runs: AutomationRunService,
    private readonly memberPush: MemberPushService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + REMINDER_WINDOW_DAYS * MS_PER_DAY,
    );

    const memberships = await this.prisma.membership.findMany({
      where: { status: 'ACTIVE', endDate: { gte: now, lte: windowEnd } },
      include: {
        member: { select: { id: true, email: true, firstName: true } },
        membershipPlan: { select: { name: true } },
      },
    });

    let sent = 0;
    for (const membership of memberships) {
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
      if (!membership.member.email) continue;
      const outcome = await this.runs.attempt(
        membership.organizationId,
        'MEMBERSHIP_RENEWAL_REMINDER',
        membership.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.sendMembershipRenewalReminder(
            membership.organizationId,
            membership.member.id,
            membership.member.email || '',
            {
              firstName: membership.member.firstName,
              planName: membership.membershipPlan.name,
              expiryDate: membership.endDate.toISOString().slice(0, 10),
            },
          ),
        { daysUntilExpiry },
      );
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Membership renewal scan: ${memberships.length} expiring in window, ${sent} reminders sent`,
    );
    return { checked: memberships.length, sent };
  }
}
