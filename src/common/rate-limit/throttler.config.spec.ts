import { DEFAULT_THROTTLE_LIMIT, throttlerEntry } from './throttler.config';

/**
 * The one-entry invariant this spec guards:
 *
 * `@nestjs/throttler` gives every config without an explicit `name` the
 * name `'default'`. Two unnamed entries therefore share one counter and
 * each increment it, so every request counts twice and every limit is
 * silently halved. Adding a second entry looks like "a stricter limit for
 * area X" and is actually that.
 */
describe('throttlerEntry', () => {
  it('is a single unnamed entry, so it is the default every route falls back to', () => {
    expect(throttlerEntry.name).toBeUndefined();
  });

  it('allows the documented 120 requests per minute', () => {
    expect(throttlerEntry.limit).toBe(DEFAULT_THROTTLE_LIMIT);
    expect(throttlerEntry.limit).toBe(120);
    expect(throttlerEntry.ttl).toBe(60_000);
  });
});
