import { Collector, CollectorResult, runCollector } from '../collectors.types';

/**
 * The framework's guarantees, tested independently of any real collector:
 * a card degrades on its own, never throws, and never fabricates a value.
 */
describe('runCollector', () => {
  const ok = <T>(value: T): CollectorResult<T> => ({
    status: 'ok',
    value,
    latencyMs: 0,
    checkedAt: '2026-10-03T00:00:00.000Z',
  });

  function collector(
    collect: () => Promise<CollectorResult>,
    timeoutMs = 1_000,
  ): Collector {
    return { name: 'test', timeoutMs, collect };
  }

  it("returns the collector's own result when it succeeds, stamped by the framework", async () => {
    const result = await runCollector(collector(async () => ok({ up: true })));

    expect(result.status).toBe('ok');
    expect(result.value).toEqual({ up: true });
    // The framework stamps checkedAt itself rather than trusting the
    // collector: a collector that reported its own timestamp could report a
    // stale one, and "as of" is exactly the field an operator reads when
    // deciding whether to trust a card.
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(result.checkedAt).not.toBe('2026-10-03T00:00:00.000Z');
  });

  it('turns a thrown collector into an unavailable card rather than rejecting', async () => {
    const result = await runCollector(
      collector(async () => {
        throw new Error('redis unreachable');
      }),
    );

    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
    expect(result.unavailableReason).toBe('redis unreachable');
  });

  it('turns a rejected promise into an unavailable card rather than rejecting', async () => {
    const result = await runCollector(
      collector(() => Promise.reject(new Error('ECONNREFUSED'))),
    );

    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('ECONNREFUSED');
  });

  it('reports a hung collector as unavailable instead of hanging the snapshot', async () => {
    const result = await runCollector(
      collector(() => new Promise<CollectorResult>(() => {}), 50),
    );

    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
    expect(result.unavailableReason).toContain('exceeded its 50ms budget');
  });

  it('never fabricates a zero for a measurement it could not take', async () => {
    // The distinction that matters on an ops console: an unmeasured value is
    // null, so a renderer cannot mistake "we could not see this" for "this is
    // zero" and paint it green.
    const result = await runCollector(
      collector(() => Promise.reject(new Error('down'))),
    );

    expect(result.value).not.toBe(0);
    expect(result.value).toBeNull();
  });

  it('keeps a degraded verdict distinct from unavailable', async () => {
    // A collector that ran and found something wrong is a different answer
    // from one that could not run; both must survive the wrapper unchanged.
    const degraded = await runCollector(
      collector(async () => ({
        ...ok({ queue: 'backlogged' }),
        status: 'degraded' as const,
      })),
    );

    expect(degraded.status).toBe('degraded');
    expect(degraded.value).toEqual({ queue: 'backlogged' });
  });

  it('measures its own latency even when the collector fails', async () => {
    const result = await runCollector(
      collector(async () => {
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('late failure');
      }),
    );

    expect(result.status).toBe('unavailable');
    expect(result.latencyMs).toBeGreaterThanOrEqual(25);
  });
});
