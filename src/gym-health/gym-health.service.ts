import { Injectable } from '@nestjs/common';
import { FinanceService } from '../analytics/finance.service';
import { InventoryIntelligenceService } from '../analytics/inventory-intelligence.service';
import { MemberIntelligenceService } from '../analytics/member-intelligence.service';
import { SalesIntelligenceService } from '../analytics/sales-intelligence.service';
import {
  IntelligenceAnalyticsService,
  type RevenueAtRisk,
} from '../member-intelligence/intelligence-analytics.service';
import {
  computeHealthScore,
  healthStatus,
  type GymHealth,
} from './gym-health.score';

/**
 * Gym Health Score aggregation.
 *
 * A leaf over existing analytics services: every number comes from the
 * same service the dedicated pages read, so the score can never disagree
 * with the rest of the product. No new tables, no persisted snapshots —
 * the score is computed live per request. Revenue-at-risk is NOT
 * recomputed here; the dedicated endpoint owns it.
 */
@Injectable()
export class GymHealthService {
  constructor(
    private readonly finance: FinanceService,
    private readonly members: MemberIntelligenceService,
    private readonly sales: SalesIntelligenceService,
    private readonly inventory: InventoryIntelligenceService,
    private readonly risk: IntelligenceAnalyticsService,
  ) {}

  async getHealth(
    organizationId: string,
    branchScope: string | null,
  ): Promise<GymHealth & { revenueAtRisk: RevenueAtRisk }> {
    const [summary, breakdown, funnel, forecast, revenueAtRisk] =
      await Promise.all([
        this.finance.getRevenueSummary(organizationId, {}, branchScope),
        this.members.getStatusBreakdown(organizationId, branchScope),
        this.sales.getFunnel(organizationId, branchScope, {}),
        this.inventory.getStockForecast(organizationId, branchScope),
        this.risk.getRevenueAtRisk(organizationId, branchScope ?? undefined),
      ]);

    const gross = summary.revenue.reduce(
      (sum, r) => sum + Number(r.grossRevenue),
      0,
    );
    const net = summary.revenue.reduce(
      (sum, r) => sum + Number(r.netRevenue),
      0,
    );
    const outstanding = summary.outstanding.reduce(
      (sum, r) => sum + Number(r.outstandingBalance),
      0,
    );
    const activeMembers = breakdown
      .filter((row) => row.status === 'ACTIVE')
      .reduce((sum, row) => sum + row.count, 0);
    const atRiskMembers = (
      await this.members.getAtRiskMembers(organizationId, branchScope)
    ).length;
    const lowStockProducts = forecast.filter(
      (p) => p.atOrBelowReorderLevel,
    ).length;

    const { components, score, opportunity } = computeHealthScore({
      gross,
      net,
      outstanding,
      activeMembers,
      atRiskMembers,
      totalLeads: funnel.totalLeads,
      conversionRatePct: Number(funnel.conversionRatePct),
      totalProducts: forecast.length,
      lowStockProducts,
    });

    // Ratios blend whatever currencies the rows carry. Single-currency
    // orgs (the norm) are exact; mixed orgs get a flag, never a guess.
    const mixedCurrencies =
      new Set([
        ...summary.revenue.map((r) => r.currency),
        ...summary.outstanding.map((r) => r.currency),
      ]).size > 1;

    return {
      score,
      status: healthStatus(score),
      opportunity,
      components,
      branchId: branchScope,
      computedAt: new Date().toISOString(),
      mixedCurrencies,
      revenueAtRisk,
    };
  }
}
