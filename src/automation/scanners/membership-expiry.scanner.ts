import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipsService } from '../../memberships/memberships.service';
import { AutomationRunService } from '../automation-run.service';

const COOLDOWN_DAYS = 30;

/**
 * Daily expiry sweep, the state-machine half of the membership lifecycle:
 *
 * 1. Flip every ACTIVE membership whose endDate has passed to EXPIRED --
 *    transactionally, with a MembershipStatusHistory trail row and a
 *    member rollup-status sync (MembershipsService.expireAllDue).
 * 2. Send one expiry notice per expired membership, email channel,
 *    TRANSACTIONAL category, gated by the AutomationRunService cooldown.
 *
 * The status flip and the notice are deliberately decoupled: the flip
 * must happen even when email fails (it's bookkeeping, not marketing).
 */
@Injectable()
export class MembershipExpiryScanner {
  private readonly logger = new Logger(MembershipExpiryScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: MembershipsService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ expired: number; notified: number }> {
    const organizationIds = await this.prisma.membership.groupBy({
      by: ['organizationId'],
      where: { status: 'ACTIVE', endDate: { lte: new Date() } },
    });

    let expired = 0;
    for (const { organizationId } of organizationIds) {
      expired += await this.memberships.expireAllDue(organizationId);
    }

    let notified = 0;
    if (expired > 0) {
      const freshlyExpired = await this.prisma.membership.findMany({
        where: { status: 'EXPIRED' },
        include: {
          member: { select: { id: true, email: true, firstName: true } },
          membershipPlan: { select: { name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: expired,
      });
      for (const membership of freshlyExpired) {
        if (!membership.member.email) continue;
        const outcome = await this.runs.attempt(
          membership.organizationId,
          'MEMBERSHIP_EXPIRY_NOTICE',
          membership.id,
          COOLDOWN_DAYS,
          () =>
            this.communications.sendMembershipExpiredNotice(
              membership.organizationId,
              membership.member.id,
              membership.member.email || '',
              {
                firstName: membership.member.firstName,
                planName: membership.membershipPlan.name,
                endDate: membership.endDate.toISOString().slice(0, 10),
              },
            ),
          { endDate: membership.endDate.toISOString() },
        );
        if (outcome === 'SENT') notified++;
      }
    }

    this.logger.log(
      `Membership expiry scan: ${expired} expired, ${notified} notices sent`,
    );
    return { expired, notified };
  }
}
