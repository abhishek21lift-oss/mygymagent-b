import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { readableDate, runningOrganization } from '../automation-scope';
import { MemberMessenger } from '../member-messenger.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Nudge weekly while lapsed, at most this many days past expiry. */
const COOLDOWN_DAYS = 7;
const MAX_DAYS_PAST_EXPIRY = 30;

/**
 * Trigger: a membership whose `endDate` is 1..30 days in the past with
 * no later ACTIVE/PENDING/FROZEN membership succeeding it (the member
 * has not renewed). Conditions: the gym's MEMBERSHIP_POST_EXPIRY switch
 * is on and the hourly tick lands in the gym's 07:00 window.
 * Idempotency: subject `<membershipId>:post` with a 7-day cooldown, so
 * a still-lapsed member hears at most weekly, never daily.
 */
@Injectable()
export class MembershipPostExpiryScanner {
  private readonly logger = new Logger(MembershipPostExpiryScanner.name);

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
    const oldest = new Date(
      startOfToday.getTime() - MAX_DAYS_PAST_EXPIRY * MS_PER_DAY,
    );

    const memberships = await this.prisma.membership.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRED'] },
        endDate: { gte: oldest, lt: startOfToday },
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
          'MEMBERSHIP_POST_EXPIRY',
          membership.organization.timezone,
          now,
        );
        windows.set(membership.organizationId, due);
      }
      if (!due) continue;
      checked++;
      const daysPastExpiry = Math.floor(
        (startOfToday.getTime() - membership.endDate.getTime()) / MS_PER_DAY,
      );
      const expiryDate = readableDate(
        membership.endDate,
        membership.organization.timezone,
      );
      const { outcome } = await this.messenger.deliver({
        organizationId: membership.organizationId,
        key: 'MEMBERSHIP_POST_EXPIRY',
        subjectId: `${membership.id}:post`,
        cooldownDays: COOLDOWN_DAYS,
        member: membership.member,
        whatsapp: {
          templateKey: 'post_expiry.nudge',
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
        detail: { daysPastExpiry },
      });
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Membership post-expiry scan: ${checked} lapsed, ${sent} nudges sent`,
    );
    return { checked, sent };
  }
}
