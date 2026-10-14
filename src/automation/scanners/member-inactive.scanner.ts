import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { runningOrganization } from '../automation-scope';
import { MemberMessenger } from '../member-messenger.service';
import { WhatsappProfileService } from '../whatsapp-profile.service';

const FALLBACK_THRESHOLD_DAYS = 30;
const COOLDOWN_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trigger: a currently-ACTIVE member whose most recent Attendance
 * check-in (or `joinedAt`, if they've never checked in) is more than
 * the gym's irregular threshold ago (profile override, else 30 days).
 * Deliberately behavioral, not `Member.status === 'INACTIVE'` -- that
 * status is a staff-set classification, a different thing from "hasn't
 * shown up in a while." A member staff have already marked INACTIVE is
 * out of scope for this re-engagement. Conditions: the gym's
 * MEMBER_INACTIVE_RECOVERY switch is on, the hourly tick lands in the
 * gym's 08:00 window, and nothing was sent since the member's last
 * visit (once per absence). Action: WhatsApp `inactive.winback` first
 * (only with MARKETING consent -- re-engagement is marketing-adjacent,
 * and the consent gate lives here because the gym-number sender only
 * carries TRANSACTIONAL), else the existing consent-gated email.
 * Subscription state is deliberately ignored here: an active
 * subscription with no visits is exactly the irregular member.
 */
@Injectable()
export class MemberInactiveScanner {
  private readonly logger = new Logger(MemberInactiveScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly messenger: MemberMessenger,
    private readonly profiles: WhatsappProfileService,
  ) {}

  async scan(
    now: Date = new Date(),
  ): Promise<{ checked: number; sent: number }> {
    const members = await this.prisma.member.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        OR: [{ email: { not: null } }, { phone: { not: null } }],
        organization: runningOrganization,
      },
      select: {
        id: true,
        organizationId: true,
        email: true,
        phone: true,
        firstName: true,
        joinedAt: true,
        attendances: {
          orderBy: { checkInAt: 'desc' },
          take: 1,
          select: { checkInAt: true },
        },
        consents: {
          where: { type: 'MARKETING' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { granted: true },
        },
        organization: { select: { name: true, timezone: true } },
      },
    });

    const windows = new Map<string, boolean>();
    const thresholds = new Map<string, number>();
    let sent = 0;
    let checked = 0;
    for (const member of members) {
      let threshold = thresholds.get(member.organizationId);
      if (threshold === undefined) {
        try {
          threshold = await this.profiles.irregularThreshold(
            member.organizationId,
          );
        } catch {
          threshold = FALLBACK_THRESHOLD_DAYS;
        }
        thresholds.set(member.organizationId, threshold);
      }
      const lastActivity = member.attendances[0]?.checkInAt ?? member.joinedAt;
      const daysInactive = Math.floor(
        (now.getTime() - lastActivity.getTime()) / MS_PER_DAY,
      );
      if (daysInactive < threshold) continue;
      let due = windows.get(member.organizationId);
      if (due === undefined) {
        due = await this.messenger.sendWindowOpen(
          member.organizationId,
          'MEMBER_INACTIVE_RECOVERY',
          member.organization.timezone,
          now,
        );
        windows.set(member.organizationId, due);
      }
      if (!due) continue;
      checked++;

      // Once per absence: a member who left a year ago was told "we miss
      // you" every fortnight, forever. Anything already sent (or skipped
      // for consent) since their last visit settles this absence; coming
      // back and lapsing again starts a new one.
      const alreadyThisAbsence = await this.prisma.automationRun.findFirst({
        where: {
          organizationId: member.organizationId,
          key: 'MEMBER_INACTIVE_RECOVERY',
          subjectId: member.id,
          status: { not: 'FAILED' },
          createdAt: { gte: lastActivity },
        },
        select: { id: true },
      });
      if (alreadyThisAbsence) continue;

      const consented = member.consents[0]?.granted ?? false;
      const { outcome } = await this.messenger.deliver({
        organizationId: member.organizationId,
        key: 'MEMBER_INACTIVE_RECOVERY',
        subjectId: member.id,
        cooldownDays: COOLDOWN_DAYS,
        member: { id: member.id, email: member.email, phone: member.phone },
        ...(member.phone && consented
          ? {
              whatsapp: {
                templateKey: 'inactive.winback',
                variables: {
                  '1': member.firstName,
                  '2': member.organization.name,
                  '3': String(daysInactive),
                },
              },
            }
          : {}),
        email: () =>
          this.communications.sendInactiveMemberRecovery(
            member.organizationId,
            member.id,
            member.email || '',
            { firstName: member.firstName, daysInactive: String(daysInactive) },
          ),
        detail: { daysInactive, thresholdDays: threshold },
      });
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Member inactivity scan: ${checked} members past their threshold, ${sent} recovery messages sent`,
    );
    return { checked, sent };
  }
}
