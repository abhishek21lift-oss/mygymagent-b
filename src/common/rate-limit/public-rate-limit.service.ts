import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { QueueConnection } from '../../queue/queue.module';

/**
 * Fixed-window counter for the `@Public()` endpoints whose credential is a
 * shared secret in the request body rather than a session (kiosk
 * check-in, kiosk session).
 *
 * Redis `INCR` + `EXPIRE`, replacing the row-locked database counter: the
 * `SELECT ... FOR UPDATE` version serialized every request for the same
 * key behind one hot row, on exactly the endpoints unauthenticated
 * devices hammer. Same fixed-window semantics, same hashed key (a client
 * key is usually an IP address -- personal data we have no reason to
 * keep in plaintext), same 429.
 *
 * Fails OPEN if Redis errors: the shared secret is still required, and a
 * queue-transport outage must not stop the gym's check-in flow. Boot
 * already requires Redis, so this is the same outage either way.
 */
@Injectable()
export class PublicRateLimitService {
  constructor(private readonly queueConnection: QueueConnection) {}

  /** Keys are hashed: a client key is usually an IP address, which is
   * personal data we have no reason to keep in plaintext. */
  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  async consume(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const redisKey = `public-ratelimit:${scope}:${this.hashKey(key || 'unknown')}`;
    let hits: number;
    try {
      hits = await this.queueConnection.client.incr(redisKey);
      if (hits === 1) {
        await this.queueConnection.client.expire(redisKey, windowSeconds);
      }
    } catch {
      return;
    }
    if (hits > limit) {
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
