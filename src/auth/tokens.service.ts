import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
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

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
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

  signAccessToken(userId: string): string {
    const payload: AccessTokenPayload = { sub: userId, type: 'access' };
    const expiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // `ms`'s TS types demand a branded literal string we can't produce
      // from a runtime env value; the value is genuinely a duration string.
      expiresIn: expiresIn as unknown as number,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
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

  async findValidRefreshToken(token: string) {
    const tokenHash = hashOpaqueToken(token);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!record || record.revokedAt || record.expiresAt < new Date())
      return null;
    return record;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
