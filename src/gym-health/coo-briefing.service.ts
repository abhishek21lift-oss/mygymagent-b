import { Injectable } from '@nestjs/common';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import { TodayFiguresService } from '../analytics/today-figures.service';
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
    /// organization's currency only, never a blended sum.
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
    private readonly todayFigures: TodayFiguresService,
    private readonly aiActions: AiActionsService,
  ) {}

  async getBriefing(
    organizationId: string,
    branchScope: string | null,
  ): Promise<CooBriefing> {
    const now = new Date();
    // Today and yesterday are the gym's days, counted exactly as the
    // dashboard counts them (TodayFiguresService). This used to take the
    // UTC date -- before 05:30 IST that was yesterday -- count staff
    // check-ins, and compare today against a range that included today.
    const yesterdayStr = await this.todayFigures.gymDay(organizationId, 1);
    const [health, today, yesterday, pending, outcomes, usage] =
      await Promise.all([
        this.health.getHealth(organizationId, branchScope),
        this.todayFigures.forDay(organizationId, branchScope),
        this.todayFigures.forDay(organizationId, branchScope, yesterdayStr),
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

    // Yesterday in today's currency: a different currency is not "zero".
    const yesterdayMoney =
      yesterday.currency === today.currency
        ? yesterday
        : { collected: 0, net: 0 };
    const currencies = [
      ...new Set([
        today.currency,
        ...today.currencies,
        ...yesterday.currencies,
      ]),
    ];
    return {
      computedAt: now.toISOString(),
      branchId: branchScope,
      health,
      today: {
        date: today.date,
        revenueNet: today.net.toFixed(2),
        collected: today.collected.toFixed(2),
        checkIns: today.checkIns,
        currency: today.currency,
        currencies,
        mixed: currencies.length > 1,
      },
      deltas: {
        revenueNetPct: pctChange(today.net, yesterdayMoney.net),
        collectedPct: pctChange(today.collected, yesterdayMoney.collected),
        checkinsPct: pctChange(today.checkIns, yesterday.checkIns),
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
