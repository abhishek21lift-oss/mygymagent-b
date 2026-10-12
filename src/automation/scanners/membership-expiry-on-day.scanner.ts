import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { readableDate, runningOrganization } from '../automation-scope';
import { MemberMessenger } from '../member-messenger.service';

const COOLDOWN_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trigger: an ACTIVE membership whose `endDate` falls within today
 * (UTC day -- the renewal scanner owns t7/t3, this owns t0, so the two
 * never double-send). Conditions: the gym's MEMBERSHIP_EXPIRY_ON_DAY
 * switch is on and the hourly tick lands in the gym's 08:00 window; the
 * membership is not already succeeded by a later ACTIVE/PENDING/FROZEN
 * one. Action: WhatsApp `renewal.t0` with the same email fallback the
 * renewal scanner uses. Idempotency: the `t0` stage subject with a
 * 30-day cooldown -- renewal.t7/t3 stages never collide with it.
 */
@Injectable()
export class MembershipExpiryOnDayScanner {
  private readonly logger = new Logger(MembershipExpiryOnDayScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly messenger: MemberMessenger,
  ) {}

  async scan(
    now: Date = new Date(),
  ): Promise<{ checked: number; sent: number }> {
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfTomorrow = new Date(startOfToday.getTime() + MS_PER_DAY);

    const memberships = await this.prisma.membership.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { gte: startOfToday, lt: startOfTomorrow },
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

    const windows = new Map<string, boolean>();
    let sent = 0;
    let checked = 0;
    for (const membership of memberships) {
      const renewed = membership.member.memberships.some(
        (other) =>
          other.id !== membership.id && other.endDate > membership.endDate,
      );
      if (renewed) continue;
      let due = windows.get(membership.organizationId);
      if (due === undefined) {
        due = await this.messenger.sendWindowOpen(
          membership.organizationId,
          'MEMBERSHIP_EXPIRY_ON_DAY',
          membership.organization.timezone,
          now,
        );
        windows.set(membership.organizationId, due);
      }
      if (!due) continue;
      checked++;
      const expiryDate = readableDate(
        membership.endDate,
        membership.organization.timezone,
      );
      const { outcome } = await this.messenger.deliver({
        organizationId: membership.organizationId,
        key: 'MEMBERSHIP_EXPIRY_ON_DAY',
        subjectId: membership.id,
        cooldownDays: COOLDOWN_DAYS,
        member: membership.member,
        whatsapp: {
          templateKey: 'renewal.t0',
          stage: 't0',
          cooldownDays: COOLDOWN_DAYS,
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
        detail: { daysUntilExpiry: 0 },
      });
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Membership on-day expiry scan: ${checked} ending today, ${sent} reminders sent`,
    );
    return { checked, sent };
  }
}
