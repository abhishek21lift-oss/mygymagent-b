import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Collector, CollectorResult } from '../collectors.types';

export interface AutomationKeyRow {
  key: string;
  sent: number;
  skipped: number;
  failed: number;
}

export interface AutomationCard {
  sent: number;
  skipped: number;
  failed: number;
  windowMs: number;
  /** Per automation, busiest first. */
  byKey: AutomationKeyRow[];
}

const FAILURE_RATE_ALERT = 0.1;
const MIN_RUNS_FOR_RATE_ALERT = 5;

/**
 * What the daily scanners actually did, from AutomationRun -- the audit row
 * every scanner writes per subject. A queue can show zero failed jobs while
 * every renewal reminder was SKIPPED for want of consent or a phone number;
 * this card is where that shows up.
 */
@Injectable()
export class AutomationCollector implements Collector<AutomationCard> {
  readonly name = 'automation';
  readonly timeoutMs = 5_000;
  readonly windowMs = 24 * 60 * 60 * 1_000;

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<CollectorResult<AutomationCard>> {
    const rows = await this.prisma.automationRun.groupBy({
      by: ['key', 'status'],
      where: { createdAt: { gte: new Date(Date.now() - this.windowMs) } },
      _count: { _all: true },
    });

    const byKeyMap = new Map<string, AutomationKeyRow>();
    for (const row of rows) {
      const entry = byKeyMap.get(row.key) ?? {
        key: row.key,
        sent: 0,
        skipped: 0,
        failed: 0,
      };
      if (row.status === 'SENT') entry.sent += row._count._all;
      else if (row.status === 'SKIPPED') entry.skipped += row._count._all;
      else if (row.status === 'FAILED') entry.failed += row._count._all;
      byKeyMap.set(row.key, entry);
    }
    const byKey = [...byKeyMap.values()].sort(
      (a, b) => b.sent + b.skipped + b.failed - (a.sent + a.skipped + a.failed),
    );

    const sent = byKey.reduce((sum, row) => sum + row.sent, 0);
    const skipped = byKey.reduce((sum, row) => sum + row.skipped, 0);
    const failed = byKey.reduce((sum, row) => sum + row.failed, 0);
    const runs = sent + skipped + failed;

    return {
      status:
        runs >= MIN_RUNS_FOR_RATE_ALERT && failed / runs > FAILURE_RATE_ALERT
          ? 'degraded'
          : 'ok',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: { sent, skipped, failed, windowMs: this.windowMs, byKey },
    };
  }
}
