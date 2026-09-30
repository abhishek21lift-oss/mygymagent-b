import { Injectable, Logger } from '@nestjs/common';
import { bookedFreezeDays } from '../../memberships/freeze-days';
import { PrismaService } from '../../prisma/prisma.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Keeps membership statuses true to the calendar. Nothing else moves them
 * with time: a membership stayed ACTIVE after its end date for ever (so
 * active counts, lifecycle analytics and check-in lists were all wrong,
 * and the portal told a lapsed member they were active), and a
 * freeze never ended on its own, so `resume()` weeks later credited every
 * day since, far past what was booked.
 *
 * Hourly rather than daily: a membership that ends at 10:00 should not
 * read ACTIVE until tomorrow. Both passes are single guarded writes and
 * safe to re-run; a row is only touched while it is still in the status
 * being moved from.
 *
 * Every organization, running or not: this records what the calendar
 * says, it sends nothing.
 */
@Injectable()
export class MembershipStatusScanner {
  private readonly logger = new Logger(MembershipStatusScanner.name);

  constructor(private readonly prisma: PrismaService) {}

  async scan(now: Date = new Date()): Promise<{
    resumed: number;
    expired: number;
  }> {
    // Resume first: a freeze that ended long ago may push the end date
    // past now, or leave it behind -- the expiry pass settles either.
    const resumed = await this.resumeEndedFreezes(now);
    const { count: expired } = await this.prisma.membership.updateMany({
      where: { status: 'ACTIVE', endDate: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    if (resumed || expired) {
      this.logger.log(
        `Membership status: ${resumed} freezes ended, ${expired} memberships expired`,
      );
    }
    return { resumed, expired };
  }

  /** Ends each freeze whose booked end has passed, crediting the booked
   * days -- exactly what `resume()` credits on that day. */
  private async resumeEndedFreezes(now: Date): Promise<number> {
    const frozen = await this.prisma.membership.findMany({
      where: { status: 'FROZEN', freezeEndDate: { lte: now } },
      select: {
        id: true,
        endDate: true,
        freezeStartDate: true,
        freezeEndDate: true,
        totalFreezeDaysUsed: true,
      },
    });
    let resumed = 0;
    for (const membership of frozen) {
      const start = membership.freezeStartDate ?? membership.freezeEndDate!;
      const days = bookedFreezeDays(start, membership.freezeEndDate!);
      const { count } = await this.prisma.membership.updateMany({
        where: { id: membership.id, status: 'FROZEN' },
        data: {
          status: 'ACTIVE',
          endDate: new Date(membership.endDate.getTime() + days * MS_PER_DAY),
          freezeStartDate: null,
          freezeEndDate: null,
          totalFreezeDaysUsed: membership.totalFreezeDaysUsed + days,
        },
      });
      resumed += count;
    }
    return resumed;
  }
}
