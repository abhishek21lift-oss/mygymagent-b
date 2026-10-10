import IORedis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler-storage';

/**
 * The fail-open contract matters most here: a Redis outage must not lock
 * every user out of the API. The rest pins the fixed-window semantics the
 * guard relies on -- it refuses a request only when the record says so.
 *
 * `pttl` is called for two keys per increment (the block key, then the
 * hit counter), so the fakes answer per key rather than in call order.
 */
describe('RedisThrottlerStorage', () => {
  const makeClient = (pttlImpl: (key: string) => number) =>
    ({
      incr: jest.fn(),
      pexpire: jest.fn(),
      pttl: jest.fn(async (key: string) => pttlImpl(key)),
      set: jest.fn(),
    }) as unknown as IORedis;

  /** No block open, hit counter fresh. */
  const noBlock = (key: string) =>
    key.startsWith('throttle-block') ? -2 : 60_000;

  it('counts a hit and opens the window on the first request', async () => {
    const client = makeClient(noBlock);
    (client.incr as jest.Mock).mockResolvedValue(1);
    (client.pexpire as jest.Mock).mockResolvedValue(1);

    const storage = new RedisThrottlerStorage(client);
    const record = await storage.increment('k', 60_000, 5, 60_000, 'default');

    expect(client.incr).toHaveBeenCalledWith('throttle:default:k');
    expect(client.pexpire).toHaveBeenCalledWith('throttle:default:k', 60_000);
    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
  });

  it('does not re-extend the window on later hits', async () => {
    const client = makeClient(noBlock);
    (client.incr as jest.Mock).mockResolvedValue(3);

    const storage = new RedisThrottlerStorage(client);
    await storage.increment('k', 60_000, 5, 60_000, 'default');

    expect(client.pexpire).not.toHaveBeenCalled();
  });

  it('blocks the request that crosses the limit and reports the block window', async () => {
    const client = makeClient(noBlock);
    (client.incr as jest.Mock).mockResolvedValue(6);

    const storage = new RedisThrottlerStorage(client);
    const record = await storage.increment('k', 60_000, 5, 60_000, 'default');

    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(60);
    // NX: hits during an open block must not extend it.
    expect(client.set).toHaveBeenCalledWith(
      'throttle-block:default:k',
      '1',
      'PX',
      60_000,
      'NX',
    );
  });

  it('stays blocked while the block key is alive, without counting more hits', async () => {
    const client = makeClient((key) =>
      key.startsWith('throttle-block') ? 30_000 : 60_000,
    );

    const storage = new RedisThrottlerStorage(client);
    const record = await storage.increment('k', 60_000, 5, 60_000, 'default');

    expect(client.incr).not.toHaveBeenCalled();
    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(30);
  });

  it('fails open when Redis errors, so an outage cannot lock users out', async () => {
    const client = makeClient(() => {
      throw new Error('Redis down');
    });

    const storage = new RedisThrottlerStorage(client);
    const record = await storage.increment('k', 60_000, 5, 60_000, 'default');

    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(1);
  });
});
