import { SnapshotService, type SnapshotCache } from './snapshot.service';
import type { Collector, CollectorResult } from './collectors.types';

describe('SnapshotService', () => {
  const ok = (value: unknown): CollectorResult =>
    ({
      status: 'ok',
      value,
      latencyMs: 1,
      checkedAt: '2026-10-03T00:00:00.000Z',
    }) as CollectorResult;

  /** A real TTL cache, so the caching behaviour under test is the real one. */
  function fakeCache(): SnapshotCache & { size: number } {
    const store = new Map<
      string,
      { value: ReturnType<SnapshotCache['get']>; expires: number }
    >();
    return {
      size: 0,
      get(key) {
        const hit = store.get(key);
        if (!hit) return undefined;
        if (hit.expires <= Date.now()) {
          store.delete(key);
          return undefined;
        }
        return hit.value ?? undefined;
      },
      set(key, value, ttlMs) {
        store.set(key, { value, expires: Date.now() + ttlMs });
      },
    };
  }

  let cache: ReturnType<typeof fakeCache>;

  const collector = (
    name: string,
    collect: () => Promise<CollectorResult>,
  ): Collector => ({
    name,
    timeoutMs: 100,
    collect,
  });

  beforeEach(() => {
    cache = fakeCache();
  });

  const serviceWith = (collectors: Collector[]) =>
    new SnapshotService(collectors, cache);

  it('returns every card, keyed by name', async () => {
    const snapshot = await serviceWith([
      collector('a', async () => ok({ n: 1 })),
      collector('b', async () => ok({ n: 2 })),
    ]).collect();

    expect(Object.keys(snapshot).sort()).toEqual([
      'a',
      'b',
      'collectedAt',
      'durationMs',
    ]);
  });

  it('lets one broken collector degrade one card instead of failing the snapshot', async () => {
    const snapshot = await serviceWith([
      collector('healthy', async () => ok({ n: 1 })),
      collector('broken', async () => {
        throw new Error('boom');
      }),
    ]).collect();

    expect(snapshot.healthy.status).toBe('ok');
    expect(snapshot.broken.status).toBe('unavailable');
    expect(snapshot.broken.value).toBeNull();
    expect(snapshot.broken.unavailableReason).toContain('boom');
  });

  it('keeps a hung collector from stalling the others', async () => {
    const snapshot = await serviceWith([
      collector('fast', async () => ok({ n: 1 })),
      { name: 'hung', timeoutMs: 40, collect: () => new Promise(() => {}) },
    ]).collect();

    expect(snapshot.fast.status).toBe('ok');
    expect(snapshot.hung.status).toBe('unavailable');
  });

  it('reuses a cached snapshot inside the TTL instead of re-probing', async () => {
    const probe = jest.fn().mockResolvedValue(ok({ n: 1 }));
    const service = serviceWith([collector('a', probe)]);

    await service.collect();
    await service.collect();

    // Two console tabs, or a fast double-render, must not double the load on
    // the database and the queues for the same data.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the TTL has passed', async () => {
    jest.useFakeTimers();
    try {
      const probe = jest.fn().mockResolvedValue(ok({ n: 1 }));
      const service = serviceWith([collector('a', probe)]);

      await service.collect();
      jest.advanceTimersByTime(11_000);
      await service.collect();

      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bypasses the cache when an operator asks for fresh numbers', async () => {
    const probe = jest.fn().mockResolvedValue(ok({ n: 1 }));
    const service = serviceWith([collector('a', probe)]);

    await service.collect();
    await service.collect({ bypassCache: true });

    // This is what `health.check` does: an operator who cannot believe the
    // card needs a real re-probe, not the previous answer again.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('stamps when the snapshot was taken, so a stale card is recognisable', async () => {
    const snapshot = await serviceWith([
      collector('a', async () => ok({ n: 1 })),
    ]).collect();

    expect(Number.isFinite(Date.parse(snapshot.collectedAt))).toBe(true);
    expect(snapshot.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty snapshot rather than throwing when nothing is registered', async () => {
    const snapshot = await serviceWith([]).collect();

    expect(Object.keys(snapshot).sort()).toEqual(['collectedAt', 'durationMs']);
  });
});
