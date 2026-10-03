import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { Collector, CollectorResult } from '../collectors.types';

export interface AiUsageCard {
  requests: number;
  success: number;
  errors: number;
  /**
   * Provider-reported USD, summed. Null when the provider reported no cost —
   * deliberately never derived from a static per-model rate card, because a
   * plausible-looking wrong number here becomes a billing conversation. Same
   * reasoning as the AiUsageLog model comment.
   */
  costUsd: number | null;
  tokens: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
  };
  actions: {
    pendingApproval: number;
    approved: number;
    rejected: number;
    executed: number;
    failed: number;
  };
}

/**
 * AI spend, reliability and approval-queue depth.
 *
 * Reads AiUsageLog and AiAction — the two tables that already record what
 * every AI call cost and which AI-proposed writes are waiting on a human.
 * No new table, and no second place where cost is computed.
 *
 * Platform-scoped on purpose: `organizationId` is a grouping dimension, not
 * a filter, so this card answers "what is AI costing the platform" across
 * every tenant. The per-tenant view is a different card and is not this one.
 */
@Injectable()
export class AiUsageCollector implements Collector<AiUsageCard> {
  readonly name = 'ai';
  readonly timeoutMs = 5_000;

  /** Trailing window the card covers. A field, not a constructor parameter:
   * Nest resolves constructor args from the container, and a `Date` is not a
   * provider — passing one made the whole app fail to boot. */
  readonly windowMs = 24 * 60 * 60 * 1_000;

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<CollectorResult<AiUsageCard>> {
    const where: Prisma.AiUsageLogWhereInput = {
      createdAt: { gte: new Date(Date.now() - this.windowMs) },
    };

    const [byStatus, totals, actionsByStatus] = await Promise.all([
      this.prisma.aiUsageLog.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.aiUsageLog.aggregate({
        where,
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      }),
      this.prisma.aiAction.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const count = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    const actionCount = (status: string) =>
      (actionsByStatus ?? []).find((row) => row.status === status)?._count
        ._all ?? 0;

    const sum = totals._sum;
    // Prisma returns Decimal for a Decimal column; Number() on the six-decimal
    // USD scale is exact enough for a display figure and avoids leaking a
    // Prisma type into the wire contract.
    const costUsd =
      sum.costUsd === null || sum.costUsd === undefined
        ? null
        : Number(sum.costUsd);

    return {
      status: 'ok',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: {
        requests: byStatus.reduce((sum2, r) => sum2 + r._count._all, 0),
        success: count('SUCCESS'),
        errors: count('ERROR'),
        costUsd,
        tokens: {
          prompt: sum.promptTokens ?? null,
          completion: sum.completionTokens ?? null,
          total:
            sum.promptTokens === null || sum.completionTokens === null
              ? null
              : sum.promptTokens + sum.completionTokens,
        },
        actions: {
          pendingApproval: actionCount('PENDING_APPROVAL'),
          approved: actionCount('APPROVED'),
          rejected: actionCount('REJECTED'),
          executed: actionCount('EXECUTED'),
          failed: actionCount('FAILED'),
        },
      },
    };
  }
}
