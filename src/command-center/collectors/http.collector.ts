import { Inject, Injectable } from '@nestjs/common';
import type { Collector, CollectorResult } from '../collectors.types';
import { HttpMetricsRing, type HttpSummary } from './http-metrics.ring';

/** p95 above this is slow enough for an operator to look. */
const SLOW_P95_MS = 2_000;
/** Server errors above this share of traffic mark the card degraded. */
const ERROR_SHARE_ALERT = 0.05;
const MIN_SAMPLES_FOR_ALERT = 20;

/**
 * Request latency and status mix from the in-process ring that
 * LoggingInterceptor feeds. Covers THIS instance since its last restart,
 * which the payload states (`scope`, `since`) rather than implying.
 *
 * An empty ring is a real measurement -- no traffic yet -- so it reports
 * `ok` with null percentiles, never fabricated zeros.
 */
@Injectable()
export class HttpCollector implements Collector<HttpSummary> {
  readonly name = 'http';
  readonly timeoutMs = 1_000;

  constructor(
    @Inject(HttpMetricsRing) private readonly ring: HttpMetricsRing,
  ) {}

  collect(): Promise<CollectorResult<HttpSummary>> {
    const summary = this.ring.summarize();
    const errorShare =
      summary.samples > 0 ? summary.status['5xx'] / summary.samples : 0;
    const degraded =
      summary.samples >= MIN_SAMPLES_FOR_ALERT &&
      (errorShare > ERROR_SHARE_ALERT ||
        (summary.latencyMs.p95 ?? 0) > SLOW_P95_MS);

    return Promise.resolve({
      status: degraded ? 'degraded' : 'ok',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: summary,
    });
  }
}
