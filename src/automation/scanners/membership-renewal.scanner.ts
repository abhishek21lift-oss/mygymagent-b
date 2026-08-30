import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const REMINDER_WINDOW_DAYS = 7;
const COOLDOWN_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
      if (!membership.member.email) continue;
      const daysUntilExpiry = Math.ceil(
        (membership.endDate.getTime() - now.getTime()) / MS_PER_DAY,
      );
      const outcome = await this.runs.attempt(
        membership.organizationId,
        'MEMBERSHIP_RENEWAL_REMINDER',
        membership.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.sendMembershipRenewalReminder(
            membership.organizationId,
            membership.member.id,
            membership.member.email,
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
