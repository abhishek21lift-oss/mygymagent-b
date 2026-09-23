import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Fixed-window counter for `@Public()` endpoints whose credential is a
 * shared secret in the request body rather than a session.
 *
 * Row-locked (same `FOR UPDATE` pattern as AI-4 in
 * `payments.service.ts#refund()`) so two concurrent requests from the same
 * key can't both read the pre-increment hit count and both commit,
 * undercounting the window.
 *
 * Deliberately database-backed rather than `@Throttle()`: these endpoints
 * are hit by unauthenticated devices from the open internet, and the
 * window has to hold across every application instance, not per-process.
 * `@Throttle()` still applies on top as a cheap first line of defence.
 */
@Injectable()
export class PublicRateLimitService {
  constructor(private readonly prisma: PrismaService) {}

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
    const hashedKey = this.hashKey(key || 'unknown');
    const hits = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ hits: number; windowStartedAt: Date }>
      >`SELECT hits, "window_started_at" AS "windowStartedAt" FROM public_endpoint_rate_limits WHERE scope = ${scope} AND key = ${hashedKey} FOR UPDATE`;
      const now = new Date();
      if (!rows[0]) {
        await tx.publicEndpointRateLimit.create({
          data: { scope, key: hashedKey, hits: 1, windowStartedAt: now },
        });
        return 1;
      }
      const expired =
        now.getTime() - rows[0].windowStartedAt.getTime() >=
        windowSeconds * 1000;
      const nextHits = expired ? 1 : rows[0].hits + 1;
      await tx.publicEndpointRateLimit.update({
        where: { scope_key: { scope, key: hashedKey } },
        data: {
          hits: nextHits,
          windowStartedAt: expired ? now : rows[0].windowStartedAt,
        },
      });
      return nextHits;
    });
    if (hits > limit) {
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
