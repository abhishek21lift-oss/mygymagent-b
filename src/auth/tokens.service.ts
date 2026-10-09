import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import ms from 'ms';
import { PrismaService } from '../prisma/prisma.service';

/** Shared by refresh/password-reset/email-verification tokens: generate a
 * high-entropy opaque token, persist only its hash, compare by hash. */
export function generateOpaqueToken(): string {
  return randomBytes(48).toString('hex');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Pinned on every JWT this service family signs and required on every
 * verify. The algorithm is fixed so a token can never pick its own (`none`,
 * or an asymmetric alg against an HMAC secret). Issuer/audience bind a token
 * to its purpose: access and MFA-challenge tokens share JWT_ACCESS_SECRET, so
 * besides their `type` claim they carry different audiences, and neither
 * verifies as the other.
 */
export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_ISSUER = 'mygymagent';
export const ACCESS_TOKEN_AUDIENCE = 'mygymagent:access';
export const MFA_CHALLENGE_AUDIENCE = 'mygymagent:mfa-challenge';

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
  /** User.tokenVersion at signing time; JwtStrategy rejects a mismatch. */
  ver: number;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `tokenVersion` must be the user's current User.tokenVersion -- a token
   * signed with any other value is refused by JwtStrategy. It defaults to
   * 0, the value every account starts with.
   */
  signAccessToken(userId: string, tokenVersion = 0): string {
    const payload: AccessTokenPayload = {
      sub: userId,
      type: 'access',
      ver: tokenVersion,
    };
    const expiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      // `ms`'s TS types demand a branded literal string we can't produce
      // from a runtime env value; the value is genuinely a duration string.
      expiresIn: expiresIn as unknown as number,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  }

  /** Refresh tokens are opaque, high-entropy random strings (not JWTs) so
   * they can be looked up, listed as devices, and individually revoked --
   * only their sha256 hash is ever persisted. */
  async issueRefreshToken(
    userId: string,
    meta: { deviceName?: string; ipAddress?: string; userAgent?: string },
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(64).toString('hex');
    const tokenHash = hashOpaqueToken(token);
    const expiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d');
    const expiresAt = new Date(
      Date.now() + ms(expiresIn as Parameters<typeof ms>[0]),
    );

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        deviceName: meta.deviceName,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Atomically rotates one refresh token: look up, revoke, and issue the
   * replacement inside a single transaction so two concurrent presentations
   * of the same token cannot both mint a session.
   *
   * Reuse detection: presenting an already-revoked (but unexpired) token
   * means the token was compromised and replayed -- the whole token family
   * for that user is revoked so the attacker session dies too. Returns
   * `{ reused: true }` in that case; the caller must reject with 401 and
   * should audit the event. An unknown or expired token returns null.
   */
  async rotateRefreshToken(
    token: string,
    meta: { deviceName?: string; ipAddress?: string; userAgent?: string },
  ): Promise<
    | { reused: false; userId: string; token: string; expiresAt: Date }
    | { reused: true; userId: string }
    | null
  > {
    const tokenHash = hashOpaqueToken(token);
    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '30d',
    );
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, revokedAt: true, expiresAt: true },
      });
      if (!record || record.expiresAt < now) return null;
      if (record.revokedAt) {
        // No grace window: ANY presentation of a rotated-out token is a
        // compromise signal. A grace period would let an attacker who raced
        // the legitimate holder keep their stolen successor session alive.
        // Multi-tab races are handled client-side by single-flight refresh.
        await tx.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { reused: true as const, userId: record.userId };
      }

      await tx.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: now },
      });

      const newToken = randomBytes(64).toString('hex');
      const expiresAt = new Date(
        Date.now() + ms(refreshExpiresIn as Parameters<typeof ms>[0]),
      );
      await tx.refreshToken.create({
        data: {
          userId: record.userId,
          tokenHash: hashOpaqueToken(newToken),
          deviceName: meta.deviceName,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          expiresAt,
        },
      });
      return {
        reused: false as const,
        userId: record.userId,
        token: newToken,
        expiresAt,
      };
    });
  }

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Ends every session the user has: bumps User.tokenVersion (so each
   * outstanding access token fails JwtStrategy's version check on its next
   * request) and revokes every live refresh token (so none can mint a new
   * one). For credential changes -- password reset, MFA disable,
   * deactivation. Pass `tx` to run inside the caller's transaction.
   */
  async endAllSessions(
    userId: string,
    tx: Pick<Prisma.TransactionClient, 'user' | 'refreshToken'> = this.prisma,
  ): Promise<void> {
    await endAllSessions(tx, userId);
  }
}

/** Free-function form of TokensService.endAllSessions, for services that
 * hold a Prisma client (or transaction) but not TokensService. */
export async function endAllSessions(
  db: Pick<Prisma.TransactionClient, 'user' | 'refreshToken'>,
  userId: string,
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
