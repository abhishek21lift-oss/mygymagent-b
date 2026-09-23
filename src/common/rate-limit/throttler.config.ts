import type { ThrottlerModuleOptions } from '@nestjs/throttler';

/** Requests per minute allowed to a route that sets no `@Throttle` of its
 * own. Per-area limits live on the controllers, not here. */
export const DEFAULT_THROTTLE_LIMIT = 120;
export const THROTTLE_WINDOW_MS = 60_000;

/**
 * Exactly ONE entry, and that is the whole point.
 *
 * `@nestjs/throttler` gives every config without an explicit `name` the
 * name `'default'` (see `throttler.guard.js`). A list of unnamed configs
 * therefore does not create one limiter per area — it creates N limiters
 * that collide on a single counter, each incrementing it, so one HTTP
 * request counts as N hits against the strictest limit in the list.
 *
 * This file previously held five unnamed entries (120 general, 20 auth,
 * 30 analytics, 40 members, 50 billing). Measured against the running
 * API, the fifth request from an address was refused: the advertised
 * 120/min was really 4/min, and a single page load exceeds that.
 *
 * Per-area limits belong on the routes and already are — every analytics,
 * members, billing and auth controller carries its own
 * `@Throttle({ default: … })` with the exact numbers that list was
 * reaching for. Keep this at one entry; `throttler.config.spec.ts`
 * enforces it.
 */
export const throttlerConfig: ThrottlerModuleOptions = [
  { ttl: THROTTLE_WINDOW_MS, limit: DEFAULT_THROTTLE_LIMIT },
];
