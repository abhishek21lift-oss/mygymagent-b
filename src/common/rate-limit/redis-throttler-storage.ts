import IORedis from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';

/**
 * Redis-backed `ThrottlerStorage`, so every API replica shares one counter.
 *
 * The default in-memory storage multiplied every limit by the replica
 * count (N instances = N x the advertised budget), which is exactly the
 * wrong direction for the routes that most need the limit: auth at
 * 5/min. Reuses the shared `QueueConnection` client -- no second Redis
 * consumer, and no new dependency.
 *
 * Fails OPEN on a Redis error. An outage of the queue transport must not
 * lock every user out of the API; boot already requires Redis (the
 * automation scheduler registers repeatable jobs on bootstrap), so this
 * is the same outage either way.
 *
 * Fixed window per key: the first hit sets the window's TTL, later hits
 * only count. Crossing `limit` opens a block window (NX, so hits during
 * the block do not extend it), mirroring the default storage's contract:
 * the request that crosses the limit is the first one refused, with
 * `Retry-After` seconds remaining on the block.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly client: IORedis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle-block:${throttlerName}:${key}`;
    try {
      const blockTtlMs = await this.client.pttl(blockKey);
      if (blockTtlMs > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: await this.hitsTtlSeconds(hitsKey, ttl),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockTtlMs / 1000),
        };
      }

      const totalHits = await this.client.incr(hitsKey);
      if (totalHits === 1) {
        await this.client.pexpire(hitsKey, ttl);
      }

      if (totalHits > limit) {
        await this.client.set(blockKey, '1', 'PX', blockDuration, 'NX');
        return {
          totalHits,
          timeToExpire: await this.hitsTtlSeconds(hitsKey, ttl),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockDuration / 1000),
        };
      }

      return {
        totalHits,
        timeToExpire: await this.hitsTtlSeconds(hitsKey, ttl),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch {
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /** Seconds left on the hit counter, falling back to the configured TTL. */
  private async hitsTtlSeconds(hitsKey: string, ttl: number): Promise<number> {
    const pttl = await this.client.pttl(hitsKey);
    return pttl > 0 ? Math.ceil(pttl / 1000) : Math.ceil(ttl / 1000);
  }
}
