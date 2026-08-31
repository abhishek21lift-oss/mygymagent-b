import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const INACTIVE_THRESHOLD_DAYS = 30;
const COOLDOWN_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trigger: a currently-ACTIVE member whose most recent Attendance
 * check-in (or `joinedAt`, if they've never checked in) is more than
 * `INACTIVE_THRESHOLD_DAYS` ago. Deliberately behavioral, not
 * `Member.status === 'INACTIVE'` -- that status is a staff-set
 * classification, a different thing from "hasn't shown up in a while."
 * A member staff have already marked INACTIVE is out of scope for this
 * re-engagement email. Conditions: not reminded for this member in the
 * last `COOLDOWN_DAYS`. Action: `CommunicationsService.sendInactiveMemberRecovery`
 * -- MARKETING category, so it's gated by the member's own consent
 * (enforced inside CommunicationsService.send(), not duplicated here).
 */
@Injectable()
export class MemberInactiveScanner {
  private readonly logger = new Logger(MemberInactiveScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();

    const members = await this.prisma.member.findMany({
      where: { status: 'ACTIVE', deletedAt: null, email: { not: null } },
      select: {
        id: true,
        organizationId: true,
        email: true,
        firstName: true,
        joinedAt: true,
        attendances: {
          orderBy: { checkInAt: 'desc' },
          take: 1,
          select: { checkInAt: true },
        },
      },
    });

    let sent = 0;
    let checked = 0;
    for (const member of members) {
      const lastActivity = member.attendances[0]?.checkInAt ?? member.joinedAt;
      const daysInactive = Math.floor(
        (now.getTime() - lastActivity.getTime()) / MS_PER_DAY,
      );
      if (daysInactive < INACTIVE_THRESHOLD_DAYS) continue;
      checked++;

      const outcome = await this.runs.attempt(
        member.organizationId,
        'MEMBER_INACTIVE_RECOVERY',
        member.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.sendInactiveMemberRecovery(
            member.organizationId,
            member.id,
            member.email || '',
            { firstName: member.firstName, daysInactive: String(daysInactive) },
          ),
        { daysInactive },
      );
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Member inactivity scan: ${checked} members past the ${INACTIVE_THRESHOLD_DAYS}-day threshold, ${sent} recovery emails sent`,
    );
    return { checked, sent };
  }
}
