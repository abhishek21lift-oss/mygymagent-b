import { Injectable } from '@nestjs/common';

/**
 * A bounded, in-memory ring of recent request timings.
 *
 * This codebase has no latency aggregation today: LoggingInterceptor writes a
 * line per request to stdout and Sentry is configured for errors only
 * (`tracesSampleRate: 0`), so "is the API getting slower" has no answer
 * anywhere. This ring is that answer, and it is deliberately the cheapest
 * thing that gives one — an array that is appended to and truncated, not a
 * metrics library, a time-series store, or a new dependency.
 *
 * Three properties matter more than the percentiles:
 *
 *  1. **Bounded.** A long-lived process must not accumulate one entry per
 *     request forever. Old samples are dropped, so the card always describes
 *     a window rather than "since boot".
 *  2. **Per-instance and in-memory.** It covers this process only and does not
 *     survive a restart. That is stated on the card rather than implied —
 *     a reader must be able to tell "no traffic" from "freshly restarted".
 *  3. **Cardinality-capped.** Paths are normalised to a `:param` shape before
 *     being counted, or `/members/:id/addresses` becomes a unique key per
 *     member and the ring becomes a memory leak with plausible numbers in it.
 */
@Injectable()
export class HttpMetricsRing {
  private readonly entries: {
    durationMs: number;
    statusCode: number;
    path: string;
    method: string;
    at: number;
  }[] = [];
  private readonly since = new Date().toISOString();

  constructor(private readonly capacity = 1_000) {}

  record(entry: {
    durationMs: number;
    statusCode: number;
    path?: string;
    method?: string;
  }): void {
    this.entries.push({
      durationMs: entry.durationMs,
      statusCode: entry.statusCode,
      path: normalizePath(entry.path ?? 'unknown'),
      method: entry.method ?? 'GET',
      at: Date.now(),
    });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  summarize(): HttpSummary {
    const latency = percentile(this.entries.map((e) => e.durationMs));

    const byClass = { '2xx': 0, '4xx': 0, '5xx': 0 };
    for (const entry of this.entries) {
      const bucket = `${Math.floor(entry.statusCode / 100)}xx`;
      if (bucket in byClass) {
        byClass[bucket as keyof typeof byClass] += 1;
      }
    }

    return {
      samples: this.entries.length,
      latencyMs: latency,
      status: byClass,
      slowestEndpoints: slowest(this.entries),
      windowMs: this.entries.length
        ? Date.now() - this.entries[0].at
        : Date.now() - Date.parse(this.since),
      since: this.since,
      scope: 'this-instance',
    };
  }
}

export interface HttpSummary {
  samples: number;
  /** Null, never 0, when there is nothing to measure. */
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  status: { '2xx': number; '4xx': number; '5xx': number };
  slowestEndpoints: {
    path: string;
    method: string;
    samples: number;
    p95: number | null;
  }[];
  windowMs: number;
  since: string;
  /** Always 'this-instance' — the ring cannot see other processes. */
  scope: 'this-instance';
}

/** `/members/8f2c.../addresses` -> `/members/:id/addresses`. */
export function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0];
  return withoutQuery
    .split('/')
    .map((segment) =>
      // A UUID, a numeric id, or a long opaque token is an identifier, not a
      // route. Anything short and word-like (`health`, `members`) is a route.
      /^[0-9]+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      ) ||
      segment.length >= 24
        ? ':id'
        : segment,
    )
    .join('/');
}

function percentile(values: number[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  if (values.length === 0) return { p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the ceil(q * n)-th smallest value, 1-indexed. Flooring
  // instead would make p50 of 1..100 report the 51st value.
  const at = (q: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
    ];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function slowest(entries: HttpMetricsRingEntry[], limit = 5) {
  const grouped = new Map<string, number[]>();
  for (const entry of entries) {
    const key = `${entry.method} ${entry.path}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry.durationMs);
    else grouped.set(key, [entry.durationMs]);
  }
  return [...grouped.entries()]
    .map(([key, durations]) => {
      const [method, path] = key.split(' ');
      return {
        method,
        path,
        samples: durations.length,
        p95: percentile(durations).p95,
      };
    })
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
    .slice(0, limit);
}

type HttpMetricsRingEntry = {
  durationMs: number;
  statusCode: number;
  path: string;
  method: string;
  at: number;
};

/**
 * The one ring for this process. LoggingInterceptor is constructed with
 * `new` in main.ts, outside the Nest container, so it cannot be handed a
 * provider; both it and the Command Center's HttpCollector use this
 * instance instead (the module registers it with `useValue`), which keeps
 * writer and reader on the same samples.
 */
export const HTTP_METRICS = new HttpMetricsRing();
