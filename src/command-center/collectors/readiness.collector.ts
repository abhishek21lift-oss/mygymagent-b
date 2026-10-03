import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueConnection } from '../../queue/queue.module';
import type { Collector, CollectorResult } from '../collectors.types';

export interface ReadinessCard {
  database: 'up' | 'down';
  queue: 'up' | 'down';
  latencyMs: { database: number; queue: number };
}

const PING_TIMEOUT_MS = 2_000;

/**
 * The two dependencies the existing `GET /ready` probe already checks.
 *
 * Deliberately the same two, and deliberately no third: this card exists so
 * the Command Center's verdict cannot disagree with the endpoint an
 * orchestrator acts on. If they were separate probes, a card could read
 * green while the load balancer was already pulling this instance out.
 *
 * Verdict is `degraded`, not `unavailable`, when a dependency is down — the
 * collector itself ran and produced a real answer. `unavailable` is reserved
 * for "this could not be measured at all".
 */
@Injectable()
export class ReadinessCollector implements Collector<ReadinessCard> {
  readonly name = 'readiness';
  readonly timeoutMs = 5_000;

  /**
   * `QueueConnection` rather than a raw IORedis: it is the one shared
   * connection every queue and worker already uses, so this card reports the
   * same Redis the workers depend on instead of opening a second client that
   * could be healthy while theirs is not. Same injection as
   * HealthController's readiness probe.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueConnection: QueueConnection,
  ) {}

  async collect(): Promise<CollectorResult<ReadinessCard>> {
    const [database, queue] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(() =>
        Promise.race([
          this.queueConnection.client.ping(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('queue ping timed out')),
              PING_TIMEOUT_MS,
            ).unref(),
          ),
        ]),
      ),
    ]);

    const value: ReadinessCard = {
      database: database.ok ? 'up' : 'down',
      queue: queue.ok ? 'up' : 'down',
      latencyMs: { database: database.ms, queue: queue.ms },
    };

    return {
      status: database.ok && queue.ok ? 'ok' : 'degraded',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value,
    };
  }

  private async probe(
    run: () => Promise<unknown>,
  ): Promise<{ ok: boolean; ms: number }> {
    const startedAt = Date.now();
    try {
      await run();
      return { ok: true, ms: Date.now() - startedAt };
    } catch {
      return { ok: false, ms: Date.now() - startedAt };
    }
  }
}
