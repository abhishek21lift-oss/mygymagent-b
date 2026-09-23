import { DEFAULT_THROTTLE_LIMIT, throttlerConfig } from './throttler.config';

const entries = throttlerConfig as unknown as Array<{
  name?: string;
  ttl: number;
  limit: number;
}>;

describe('throttlerConfig', () => {
  /**
   * The bug this guards against is silent: adding a second unnamed entry
   * looks like "a stricter limit for area X" and actually divides every
   * limit in the app by the number of entries, because unnamed configs
   * all resolve to the name 'default' and share one counter while each
   * increments it.
   */
  it('holds exactly one entry', () => {
    expect(Array.isArray(throttlerConfig)).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('leaves that entry unnamed, so it is the default every route falls back to', () => {
    const [only] = entries;
    expect(only.name).toBeUndefined();
  });

  it('allows the documented 120 requests per minute', () => {
    const [only] = entries;
    expect(only.limit).toBe(DEFAULT_THROTTLE_LIMIT);
    expect(only.limit).toBe(120);
    expect(only.ttl).toBe(60_000);
  });
});
