import { Injectable } from '@nestjs/common';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import { FinanceService } from '../analytics/finance.service';
import { organizationTimezone, zonedBound } from '../common/time/zoned';
import { PrismaService } from '../prisma/prisma.service';
import { GymHealthService } from './gym-health.service';

export interface CooDelta {
  /// Percentage change vs the previous day, null when yesterday is zero
  /// (a ratio off zero is noise, not growth).
  revenueNetPct: number | null;
  collectedPct: number | null;
  checkinsPct: number | null;
}

export interface CooBriefing {
  computedAt: string;
  branchId: string | null;
  health: Awaited<ReturnType<GymHealthService['getHealth']>>;
  today: {
    date: string;
    revenueNet: string;
    collected: string;
    checkIns: number;
    currency: string;
    /// All currencies present today; when mixed, amounts above are the
    /// primary currency only (first row), never a blended sum.
    currencies: string[];
    mixed: boolean;
  };
  deltas: CooDelta;
  outcomes: { pending: number; executed: number; rejected: number };
  usage: {
    requests24h: number;
    tokens24h: number;
    costUsd24h: string;
    errors24h: number;
  };
}

function pctChange(today: number, yesterday: number): number | null {
  if (yesterday <= 0) return null;
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

/**
 * COO briefing: one request for the morning screen. Composes the gym
 * health score, today's money and gate traffic, day-over-day deltas,
 * action outcomes and AI spend — every figure from the service that
 * owns it, never recomputed here beyond deltas and sums.
 */
@Injectable()
export class CooBriefingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: GymHealthService,
    private readonly finance: FinanceService,
    private readonly aiActions: AiActionsService,
  ) {}

  async getBriefing(
    organizationId: string,
    branchScope: string | null,
  ): Promise<CooBriefing> {
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const start = zonedBound(todayStr, timezone, 'from');
    const dayStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const branchWhere = branchScope ? { branchId: branchScope } : {};

    const [
      health,
      todaySummary,
      yesterdaySummary,
      checkinsToday,
      checkinsYesterday,
      pending,
      outcomes,
      usage,
    ] = await Promise.all([
      this.health.getHealth(organizationId, branchScope),
      this.finance.getRevenueSummary(
        organizationId,
        { from: todayStr, to: todayStr },
        branchScope,
      ),
      this.finance.getRevenueSummary(
        organizationId,
        {
          from: dayStart.toISOString().slice(0, 10),
          to: todayStr,
        },
        branchScope,
      ),
      this.prisma.attendance.count({
        where: {
          organizationId,
          ...branchWhere,
          deniedReason: null,
          checkInAt: { gte: start },
        },
      }),
      this.prisma.attendance.count({
        where: {
          organizationId,
          ...branchWhere,
          deniedReason: null,
          checkInAt: { gte: dayStart, lt: start },
        },
      }),
      this.aiActions.countPending(organizationId),
      this.aiActions.effectiveness(organizationId),
      this.prisma.aiUsageLog.aggregate({
        where: {
          organizationId,
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        _count: true,
        _sum: { totalTokens: true, costUsd: true },
      }),
    ]);

    const primaryCurrency =
      todaySummary.revenue[0]?.currency ??
      yesterdaySummary.revenue[0]?.currency ??
      'INR';
    const primary = (
      rows: { currency: string; grossRevenue: string; netRevenue: string }[],
    ) => {
      const row = rows.find((r) => r.currency === primaryCurrency) ?? rows[0];
      return {
        gross: row ? Number(row.grossRevenue) : 0,
        net: row ? Number(row.netRevenue) : 0,
      };
    };
    const todayPrimary = primary(todaySummary.revenue);
    const yesterdayPrimary = primary(yesterdaySummary.revenue);
    const currencies = [
      ...new Set([
        ...todaySummary.revenue.map((r) => r.currency),
        ...yesterdaySummary.revenue.map((r) => r.currency),
      ]),
    ];
    return {
      computedAt: now.toISOString(),
      branchId: branchScope,
      health,
      today: {
        date: todayStr,
        revenueNet: todayPrimary.net.toFixed(2),
        collected: todayPrimary.gross.toFixed(2),
        checkIns: checkinsToday,
        currency: primaryCurrency,
        currencies,
        mixed: currencies.length > 1,
      },
      deltas: {
        revenueNetPct: pctChange(todayPrimary.net, yesterdayPrimary.net),
        collectedPct: pctChange(todayPrimary.gross, yesterdayPrimary.gross),
        checkinsPct: pctChange(checkinsToday, checkinsYesterday),
      },
      outcomes: {
        pending,
        executed: outcomes.executed,
        rejected: outcomes.rejected,
      },
      usage: {
        requests24h: usage._count,
        tokens24h: usage._sum.totalTokens ?? 0,
        costUsd24h: Number(usage._sum.costUsd ?? 0).toFixed(4),
        errors24h: await this.prisma.aiUsageLog.count({
          where: {
            organizationId,
            createdAt: {
              gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
            },
            status: 'ERROR',
          },
        }),
      },
    };
  }
}
