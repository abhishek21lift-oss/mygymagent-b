import { Injectable } from '@nestjs/common';
import { FinanceService } from '../analytics/finance.service';
import { organizationCurrency } from '../common/money/organization-currency';
import { organizationTimezone, zonedMonthKey } from '../common/time/zoned';
import { PrismaService } from '../prisma/prisma.service';
import { IntelligenceAnalyticsService } from '../member-intelligence/intelligence-analytics.service';

export interface CooTrend {
  metric: 'revenue' | 'risk';
  label: string;
  current: number;
  previous: number;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
  currency: string | null;
  insufficientData: boolean;
}

export interface CooTrends {
  trends: CooTrend[];
  computedAt: string;
}

export interface CooForecast {
  revenueNextMonth: {
    low: string;
    high: string;
    point: string;
    currency: string;
    basedOnMonths: number;
    confidence: 'high' | 'moderate';
    method: string;
  } | null;
  insufficientData: boolean;
  computedAt: string;
}

/**
 * Trends, baselines and forecasts for the COO layer. Deterministic
 * statistics over existing analytics — moving averages and min-max
 * bands, never model output. Every figure carries its basis; anything
 * below minimum history reads as insufficient, not as zero.
 */
@Injectable()
export class CooTrendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly risk: IntelligenceAnalyticsService,
  ) {}

  async getTrends(
    organizationId: string,
    branchScope: string | null,
  ): Promise<CooTrends> {
    const currency = await organizationCurrency(this.prisma, organizationId);
    const currentKey = zonedMonthKey(
      new Date(),
      await this.timezone(organizationId),
    );
    const [months, riskPoints] = await Promise.all([
      this.finance.getRevenueTrend(organizationId, branchScope, 4),
      this.risk.getRiskTrend(organizationId, 30, branchScope ?? undefined),
    ]);
    const trends: CooTrend[] = [];

    const complete = months.filter((m) => m.month < currentKey);
    if (complete.length >= 2) {
      const [prev, curr] = complete.slice(-2);
      const net = (m: (typeof months)[number]) =>
        m.revenue
          .filter((r) => r.currency === currency)
          .reduce((sum, r) => sum + Number(r.netRevenue), 0);
      const prevNet = net(prev);
      const currNet = net(curr);
      const deltaPct =
        prevNet !== 0
          ? Math.round(((currNet - prevNet) / Math.abs(prevNet)) * 1000) / 10
          : null;
      trends.push({
        metric: 'revenue',
        label: `Net revenue (${currency})`,
        current: currNet,
        previous: prevNet,
        deltaPct,
        direction:
          deltaPct === null || deltaPct === 0
            ? 'flat'
            : deltaPct > 0
              ? 'up'
              : 'down',
        currency,
        insufficientData: false,
      });
    }

    if (riskPoints.length >= 2) {
      const first = riskPoints[0];
      const last = riskPoints[riskPoints.length - 1];
      const delta = Math.round((last.avgScore - first.avgScore) * 10) / 10;
      trends.push({
        metric: 'risk',
        label: 'Average member risk score',
        current: last.avgScore,
        previous: first.avgScore,
        deltaPct: null,
        direction: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down',
        currency: null,
        insufficientData: false,
      });
    }

    return { trends, computedAt: new Date().toISOString() };
  }

  async getForecast(
    organizationId: string,
    branchScope: string | null,
  ): Promise<CooForecast> {
    const currency = await organizationCurrency(this.prisma, organizationId);
    const months = await this.finance.getRevenueTrend(
      organizationId,
      branchScope,
      7,
    );
    const currentKey = zonedMonthKey(
      new Date(),
      await this.timezone(organizationId),
    );
    const nets = months
      .filter((m) => m.month < currentKey)
      .map((m) =>
        m.revenue
          .filter((r) => r.currency === currency)
          .reduce((sum, r) => sum + Number(r.netRevenue), 0),
      );
    if (nets.length < 3) {
      return {
        revenueNextMonth: null,
        insufficientData: true,
        computedAt: new Date().toISOString(),
      };
    }
    const window = nets.slice(-6);
    const point = window.reduce((a, b) => a + b, 0) / window.length;
    return {
      revenueNextMonth: {
        low: Math.min(...window).toFixed(2),
        high: Math.max(...window).toFixed(2),
        point: point.toFixed(2),
        currency,
        basedOnMonths: window.length,
        confidence: window.length >= 6 ? 'high' : 'moderate',
        method:
          'Moving average with min-max band over complete calendar months',
      },
      insufficientData: false,
      computedAt: new Date().toISOString(),
    };
  }

  private async timezone(organizationId: string): Promise<string> {
    return organizationTimezone(this.prisma, organizationId);
  }
}
