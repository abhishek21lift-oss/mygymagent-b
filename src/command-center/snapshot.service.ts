import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  runCollector,
  type Collector,
  type Snapshot,
} from './collectors.types';

export const COMMAND_CENTER_COLLECTORS = 'COMMAND_CENTER_COLLECTORS';
export const COMMAND_CENTER_CACHE = 'COMMAND_CENTER_CACHE';

/** Minimal cache interface, so the TTL store can be swapped or stubbed. */
export interface SnapshotCache {
  get(key: string): Snapshot | undefined;
  set(key: string, value: Snapshot, ttlMs: number): void;
}

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);
  private readonly collectors: Collector[];

  /**
   * Short enough that a polling console sees fresh numbers, long enough that
   * two tabs and a double-render do not each re-probe the database and the
   * queues. A field rather than a constructor parameter: Nest resolves
   * constructor args from the container, and a primitive is not a provider.
   */
  readonly ttlMs = 10_000;

  constructor(
    @Inject(COMMAND_CENTER_COLLECTORS) collectors: Collector[],
    @Inject(COMMAND_CENTER_CACHE) private readonly cache: SnapshotCache,
  ) {
    this.collectors = collectors;
  }

  /**
   * Collects every card in parallel and returns them as one snapshot.
   *
   * Parallel because the cards are independent, and individually guarded
   * because they are not equally reliable: one hung database must not delay
   * the AI cost figure by the readiness timeout.
   *
   * A short TTL cache sits in front, because the console polls. Without it a
   * 5s poll would issue a full set of aggregate queries and four queue-depth
   * reads per browser tab, which is a self-inflicted load problem on the
   * exact page meant to explain a load problem. The TTL is what
   * `health.check` bypasses when an operator asks for fresh numbers.
   */
  async collect(options: { bypassCache?: boolean } = {}): Promise<Snapshot> {
    const cacheKey = 'snapshot';
    if (!options.bypassCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const startedAt = Date.now();
    const entries = await Promise.all(
      this.collectors.map(async (collector) => {
        const result = await runCollector(collector);
        if (result.status === 'unavailable') {
          this.logger.warn(
            `Command Center card "${collector.name}" unavailable: ${result.unavailableReason}`,
          );
        }
        return [collector.name, result] as const;
      }),
    );

    const snapshot = {
      ...Object.fromEntries(entries),
      collectedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    } as Snapshot;

    this.cache.set(cacheKey, snapshot, this.ttlMs);
    return snapshot;
  }
}
