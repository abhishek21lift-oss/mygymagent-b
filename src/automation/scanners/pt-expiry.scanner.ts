import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const REMINDER_WINDOW_DAYS = 7;
const COOLDOWN_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trigger: an ACTIVE PT package's `endDate` falls within the next
 * `REMINDER_WINDOW_DAYS` and it still has unused sessions
 * (`usedSessions < totalSessions`, filtered in JS -- Prisma has no
 * column-to-column comparison). Conditions: not already reminded for
 * this package in the last `COOLDOWN_DAYS`
 * (AutomationRunService.attempt's cooldown check). Action: a
 * TRANSACTIONAL `pt_expiry_reminder` email to the member about their
 * own package, the same risk tier as the membership-renewal reminder.
 * No approval step. When invoked with an organizationId (the
 * SCAN_PT_EXPIRY job payload) only that org is scanned, otherwise all
 * orgs -- the daily scheduler registers the job without data, so the
 * no-arg shape is the one that actually runs in production.
 */
@Injectable()
export class PtExpiryScanner {
  private readonly logger = new Logger(PtExpiryScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(organizationId?: string): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * MS_PER_DAY);

    const packages = await this.prisma.ptPackage.findMany({
      where: {
        ...(organizationId ? { organizationId } : {}),
        status: 'ACTIVE',
        endDate: { gte: now, lte: windowEnd },
      },
      include: {
        member: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    const expiring = packages.filter(
      (pkg) => pkg.usedSessions < pkg.totalSessions,
    );

    let sent = 0;
    for (const pkg of expiring) {
      if (!pkg.member.email) continue;
      const daysUntilExpiry = Math.ceil(
        (pkg.endDate.getTime() - now.getTime()) / MS_PER_DAY,
      );
      const outcome = await this.runs.attempt(
        pkg.organizationId,
        'PT_EXPIRY_REMINDER',
        pkg.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.send({
            organizationId: pkg.organizationId,
            channel: 'EMAIL',
            category: 'TRANSACTIONAL',
            templateKey: 'pt_expiry_reminder',
            recipient: pkg.member.email as string,
            memberId: pkg.member.id,
            variables: {
              firstName: pkg.member.firstName,
              packageName: pkg.name,
              expiryDate: pkg.endDate.toISOString().slice(0, 10),
              remainingSessions: String(pkg.totalSessions - pkg.usedSessions),
              daysUntilExpiry: String(daysUntilExpiry),
            },
          }),
        { daysUntilExpiry: String(daysUntilExpiry) },
      );
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `PT expiry scan: ${expiring.length} expiring in window, ${sent} reminders sent`,
    );
    return { checked: expiring.length, sent };
  }
}
