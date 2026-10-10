import { Injectable } from '@nestjs/common';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import {
  FinanceService,
  type OutstandingScopeCache,
} from '../analytics/finance.service';
import { InventoryIntelligenceService } from '../analytics/inventory-intelligence.service';
import { TodayFiguresService } from '../analytics/today-figures.service';
import {
  MemberIntelligenceService,
  currentTermWhere,
} from '../analytics/member-intelligence.service';
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

/**
 * The Owner OS briefing, behind the AI agent's `get_owner_briefing`
 * tool. (Its page and GET /owner-os/briefing are retired: the dashboard
 * is the owner's one home screen.) Same honesty discipline as DailyBriefingService
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
    private readonly todayFigures: TodayFiguresService,
    private readonly finance: FinanceService,
  ) {}

  async getBriefing(
    organizationId: string,
    branchScope?: string,
  ): Promise<OwnerOsBriefing> {
    const now = new Date();
    const branch = branchScope ?? null;
    // Same snapshot shared by forDay's day-range revenue and the direct
    // outstanding total below — one membership scan per briefing.
    const outstandingCache: OutstandingScopeCache = new Map();
    // Today's attendance, revenue, expiring terms and dues come from the
    // services behind the dashboard, so the AI agent quotes the figures
    // the owner sees on screen. This used to count them its own way:
    // revenue without product sales, branches by the member's home
    // branch, dues on ACTIVE terms only and with failed payments counted.
    const [
      members,
      activeMemberships,
      today,
      expiringSoon,
      outstandingByCurrency,
      atRisk,
      stockForecast,
      pendingAiActions,
    ] = await Promise.all([
      this.prisma.member.count({
        where: {
          organizationId,
          deletedAt: null,
          ...(branchScope ? { primaryBranchId: branchScope } : {}),
        },
      }),
      // Terms running today. A sold renewal is ACTIVE from the day it is
      // sold but starts when the current term ends, so counting every
      // ACTIVE row counted a renewed member twice.
      this.prisma.membership.count({
        where: {
          organizationId,
          ...currentTermWhere(now),
          ...(branchScope ? { member: { primaryBranchId: branchScope } } : {}),
        },
      }),
      this.todayFigures.forDay(
        organizationId,
        branch,
        undefined,
        outstandingCache,
      ),
      this.todayFigures.expiringSoon(organizationId, branch, now),
      this.finance.getOutstandingBalances(
        organizationId,
        branch,
        outstandingCache,
      ),
      this.memberIntelligence.getAtRiskMembers(organizationId, branch),
      this.inventoryIntelligence.getStockForecast(organizationId, branch),
      this.aiActions.countPending(organizationId),
    ]);

    const currency = today.currency;
    const todayAttendance = today.checkIns;
    // Net of refunds, like every revenue figure on the dashboard.
    const todayRevenue = today.net;
    const owed = outstandingByCurrency.find((o) => o.currency === currency);
    const outstandingPayments = owed ? Number(owed.outstandingBalance) : 0;
    const membershipsWithBalance = owed?.membershipsWithBalance ?? 0;

    const lowStock = stockForecast.filter((p) => p.atOrBelowReorderLevel);

    const alerts: OwnerOsAlert[] = [];
    if (membershipsWithBalance > 0) {
      alerts.push({
        id: 'outstanding-balance',
        severity: 'high',
        title: `${membershipsWithBalance} memberships have outstanding balances`,
        detail: `${currency} ${Math.round(outstandingPayments).toLocaleString()} is yet to be collected on current memberships.`,
        href: '/dashboard/outstanding',
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
