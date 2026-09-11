import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import { InventoryIntelligenceService } from '../analytics/inventory-intelligence.service';
import { MemberIntelligenceService } from '../analytics/member-intelligence.service';
import { PrismaService } from '../prisma/prisma.service';

export interface OwnerOsAlert {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  href?: string;
}

export interface OwnerOsRecommendation {
  id: string;
  title: string;
  reason: string;
  href?: string;
}

export interface OwnerOsBriefing {
  generatedAt: string;
  currency: string;
  metrics: {
    members: number;
    activeMemberships: number;
    todayAttendance: number;
    todayRevenue: number;
    expiringSoon: number;
    outstandingPayments: number;
  };
  alerts: OwnerOsAlert[];
  recommendations: OwnerOsRecommendation[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toNumber(decimal: Prisma.Decimal | number): number {
  return decimal instanceof Prisma.Decimal ? decimal.toNumber() : decimal;
}

/**
 * The Owner OS briefing: the executive decision cockpit behind
 * GET /owner-os/briefing. Same honesty discipline as DailyBriefingService
 * (real rows, no fabricated numbers) but shaped for owners rather than
 * operators: single-currency headline metrics in the organization's own
 * currency, severity-ranked alerts, and advisory recommendations that
 * link to the screen where a human takes action.
 *
 * Multi-currency orgs: headline money metrics count only rows in the
 * org's configured currency (summing across currencies would produce a
 * meaningless number -- see FinanceService). The `currency` field names
 * which currency the numbers are in.
 */
@Injectable()
export class OwnerOsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memberIntelligence: MemberIntelligenceService,
    private readonly inventoryIntelligence: InventoryIntelligenceService,
    private readonly aiActions: AiActionsService,
  ) {}

  async getBriefing(organizationId: string): Promise<OwnerOsBriefing> {
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const in7Days = new Date(now.getTime() + 7 * MS_PER_DAY);

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true },
    });
    const currency = org?.currency ?? 'USD';

    const [
      members,
      activeMemberships,
      todayAttendance,
      paymentsToday,
      refundsToday,
      expiringSoon,
      activeWithPayments,
      atRisk,
      stockForecast,
      pendingAiActions,
    ] = await Promise.all([
      this.prisma.member.count({
        where: { organizationId, deletedAt: null },
      }),
      this.prisma.membership.count({
        where: { organizationId, status: 'ACTIVE' },
      }),
      this.prisma.attendance.count({
        where: { organizationId, checkInAt: { gte: startOfToday } },
      }),
      this.prisma.payment.findMany({
        where: {
          organizationId,
          currency,
          status: 'COMPLETED',
          createdAt: { gte: startOfToday },
        },
        select: { amount: true },
      }),
      this.prisma.refund.findMany({
        where: {
          organizationId,
          payment: { currency },
          createdAt: { gte: startOfToday },
        },
        select: { amount: true },
      }),
      this.prisma.membership.count({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { gte: now, lte: in7Days },
        },
      }),
      this.prisma.membership.findMany({
        where: { organizationId, status: 'ACTIVE', currency },
        select: {
          price: true,
          payments: {
            select: {
              amount: true,
              refunds: { select: { amount: true } },
            },
          },
        },
      }),
      this.memberIntelligence.getAtRiskMembers(organizationId, null),
      this.inventoryIntelligence.getStockForecast(organizationId),
      this.aiActions.countPending(organizationId),
    ]);

    const grossToday = paymentsToday.reduce(
      (sum, p) => sum.plus(p.amount),
      new Prisma.Decimal(0),
    );
    const refundedToday = refundsToday.reduce(
      (sum, r) => sum.plus(r.amount),
      new Prisma.Decimal(0),
    );
    const todayRevenue = toNumber(grossToday.sub(refundedToday));

    let outstandingPayments = 0;
    let membershipsWithBalance = 0;
    for (const membership of activeWithPayments) {
      const paid = membership.payments.reduce(
        (sum, payment) =>
          sum.plus(
            payment.amount.sub(
              payment.refunds.reduce(
                (refundSum, refund) => refundSum.plus(refund.amount),
                new Prisma.Decimal(0),
              ),
            ),
          ),
        new Prisma.Decimal(0),
      );
      const balance = toNumber(membership.price.sub(paid));
      if (balance > 0) {
        outstandingPayments += balance;
        membershipsWithBalance += 1;
      }
    }

    const lowStock = stockForecast.filter((p) => p.atOrBelowReorderLevel);

    const alerts: OwnerOsAlert[] = [];
    if (membershipsWithBalance > 0) {
      alerts.push({
        id: 'outstanding-balance',
        severity: 'high',
        title: `${membershipsWithBalance} memberships have outstanding balances`,
        detail: `${currency} ${Math.round(outstandingPayments).toLocaleString()} is yet to be collected on active memberships.`,
        href: '/billing',
      });
    }
    if (expiringSoon > 0) {
      alerts.push({
        id: 'expiring-memberships',
        severity: 'high',
        title: `${expiringSoon} memberships expire within 7 days`,
        detail:
          'Reach out before expiry to protect renewals -- every lapsed day is churn risk.',
        href: '/memberships',
      });
    }
    if (atRisk.length > 0) {
      alerts.push({
        id: 'at-risk-members',
        severity: 'medium',
        title: `${atRisk.length} members are at risk of churning`,
        detail:
          'No check-in for 14+ days. A personal follow-up now is cheaper than a win-back later.',
        href: '/members',
      });
    }
    if (lowStock.length > 0) {
      alerts.push({
        id: 'low-stock',
        severity: 'medium',
        title: `${lowStock.length} products are at or below reorder level`,
        detail: lowStock
          .slice(0, 3)
          .map((p) => p.name)
          .join(', '),
        href: '/inventory',
      });
    }

    const recommendations: OwnerOsRecommendation[] = [];
    if (atRisk.length > 0) {
      recommendations.push({
        id: 'recover-at-risk',
        title: 'Run an at-risk member recovery pass',
        reason: `${atRisk.length} inactive members identified by attendance intelligence. Start with the longest-absent.`,
        href: '/members',
      });
    }
    if (expiringSoon > 0) {
      recommendations.push({
        id: 'renewal-push',
        title: 'Push renewals for expiring memberships',
        reason: `${expiringSoon} renewals due in 7 days. Members who renew before expiry retain at higher rates.`,
        href: '/memberships',
      });
    }
    if (lowStock.length > 0) {
      recommendations.push({
        id: 'restock',
        title: 'Restock low inventory before stockout',
        reason: `${lowStock.length} products need reordering based on stock velocity.`,
        href: '/inventory',
      });
    }
    if (pendingAiActions > 0) {
      recommendations.push({
        id: 'review-ai-actions',
        title: `Review ${pendingAiActions} pending AI proposals`,
        reason:
          'The AI has drafted workout/diet assignments awaiting human approval.',
        href: '/ai-actions',
      });
    }

    return {
      generatedAt: now.toISOString(),
      currency,
      metrics: {
        members,
        activeMemberships,
        todayAttendance,
        todayRevenue,
        expiringSoon,
        outstandingPayments,
      },
      alerts,
      recommendations,
    };
  }
}
