import * as Sentry from '@sentry/node';

/**
 * Error tracking. Must be imported before anything else in main.ts (Sentry's
 * own convention) so its instrumentation can hook the earliest possible
 * point. A no-op when SENTRY_DSN is unset -- local dev and any deployment
 * that hasn't configured it yet keep working exactly as before; this file
 * exists so wiring it up later is an env var, not a code change.
 */
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Error tracking only by default -- no performance/tracing overhead
    // until there's a concrete need to look at request traces, not just
    // errors. Setting SENTRY_TRACES_SAMPLE_RATE to a 0..1 fraction turns
    // tracing on without a code change (see the 50k-user scaling audit:
    // the API had no way to sample traces at all).
    tracesSampleRate: (() => {
      const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
      if (!raw) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    })(),
  });
}
