import { HttpMetricsRing } from './http-metrics.ring';

describe('HttpMetricsRing', () => {
  let ring: HttpMetricsRing;

  beforeEach(() => {
    ring = new HttpMetricsRing(1_000);
  });

  it('starts empty and says so, rather than reporting zero latency', () => {
    const summary = ring.summarize();

    // An empty ring has no p95. Reporting 0ms would be indistinguishable
    // from "every request was instant", which is the opposite of the truth.
    expect(summary.samples).toBe(0);
    expect(summary.latencyMs.p50).toBeNull();
    expect(summary.latencyMs.p95).toBeNull();
    expect(summary.latencyMs.p99).toBeNull();
  });

  it('summarizes recorded requests by latency percentile', () => {
    for (let i = 1; i <= 100; i++)
      ring.record({ durationMs: i, statusCode: 200 });

    const summary = ring.summarize();

    expect(summary.samples).toBe(100);
    // Nearest-rank on a sorted sample: p50 of 1..100 is the 50th value.
    expect(summary.latencyMs.p50).toBe(50);
    expect(summary.latencyMs.p95).toBe(95);
    expect(summary.latencyMs.p99).toBe(99);
  });

  it('counts responses by status class', () => {
    ring.record({ durationMs: 10, statusCode: 200 });
    ring.record({ durationMs: 20, statusCode: 201 });
    ring.record({ durationMs: 30, statusCode: 404 });
    ring.record({ durationMs: 40, statusCode: 500 });

    expect(ring.summarize().status).toEqual({ '2xx': 2, '4xx': 1, '5xx': 1 });
  });

  it('drops the oldest samples past its bound instead of growing without limit', () => {
    const small = new HttpMetricsRing(3);
    small.record({ durationMs: 1, statusCode: 200 });
    small.record({ durationMs: 2, statusCode: 200 });
    small.record({ durationMs: 3, statusCode: 200 });
    small.record({ durationMs: 4, statusCode: 200 });

    const summary = small.summarize();

    // A long-lived process must not accumulate one entry per request
    // forever; the console reports a window, and the window is bounded.
    expect(summary.samples).toBe(3);
    expect(summary.latencyMs.p50).toBe(3);
  });

  it('names the slowest endpoints, which is the actionable part', () => {
    ring.record({
      durationMs: 5,
      statusCode: 200,
      path: '/members',
      method: 'GET',
    });
    ring.record({
      durationMs: 900,
      statusCode: 200,
      path: '/analytics/revenue',
      method: 'GET',
    });

    const summary = ring.summarize();

    expect(summary.slowestEndpoints[0]).toMatchObject({
      path: '/analytics/revenue',
      p95: 900,
    });
  });

  it('does not let a dynamic path fragment explode cardinality', () => {
    // /members/<uuid>/addresses would otherwise be a unique key per member
    // and turn a bounded ring into a memory leak with useful-looking
    // numbers in it.
    for (const id of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]) {
      ring.record({
        durationMs: 10,
        statusCode: 200,
        path: `/members/${id}/addresses`,
        method: 'GET',
      });
    }

    const paths = new Set(ring.summarize().slowestEndpoints.map((e) => e.path));
    expect(paths.size).toBe(1);
    expect([...paths][0]).toBe('/members/:id/addresses');
    // Collapsed, not dropped: all three requests are still counted.
    expect(ring.summarize().samples).toBe(3);
  });

  it('keeps short word-like segments as routes, not identifiers', () => {
    ring.record({
      durationMs: 5,
      statusCode: 200,
      path: '/members/tags',
      method: 'GET',
    });

    expect(ring.summarize().slowestEndpoints[0].path).toBe('/members/tags');
  });

  it('reports the window it covers, so a stale card is recognisable', async () => {
    ring.record({ durationMs: 10, statusCode: 200 });

    const before = ring.summarize().windowMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = ring.summarize().windowMs;

    // The window grows as the ring ages, which is what lets a reader tell a
    // card covering the last second from one covering the last hour.
    expect(after).toBeGreaterThan(before);
    expect(Number.isFinite(Date.parse(ring.summarize().since))).toBe(true);
  });
});
