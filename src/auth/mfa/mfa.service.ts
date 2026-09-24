import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_LOGIN_ATTEMPTS,
} from '../auth.service';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  parseMfaVaultKey,
} from './mfa-secret.vault';

const TOTP_STEP_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_SECONDS = 5 * 60;

/** One accepted step of clock drift either way. Wider windows multiply the
 * codes valid at any instant, which matters for a 6-digit keyspace. */
const totp = authenticator.clone({
  step: TOTP_STEP_SECONDS,
  window: [1, 1],
});

export interface MfaChallengePayload {
  sub: string;
  type: 'mfa';
}

/** Recovery codes are compared by hash, like every other opaque token in
 * this codebase. Normalizing first means the user can type it back with or
 * without the dash and in any case. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256')
    .update(code.replace(/-/g, '').toLowerCase())
    .digest('hex');
}

function generateRecoveryCode(): string {
  const raw = randomBytes(8).toString('hex'); // 64 bits
  return `${raw.slice(0, 8)}-${raw.slice(8)}`;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  private vaultKey(): Buffer {
    return parseMfaVaultKey(this.config.get<string>('MFA_TOTP_KEY'));
  }

  /** True only once enrolment has been confirmed -- a pending enrolment
   * must never gate a login, or a failed setup would lock the user out. */
  async isEnabled(userId: string): Promise<boolean> {
    const record = await this.prisma.userMfa.findUnique({
      where: { userId },
      select: { enabledAt: true },
    });
    return Boolean(record?.enabledAt);
  }

  async status(userId: string) {
    const record = await this.prisma.userMfa.findUnique({
      where: { userId },
      select: { id: true, enabledAt: true },
    });
    if (!record) {
      return {
        enabled: false,
        pendingEnrolment: false,
        recoveryCodesRemaining: 0,
      };
    }
    const remaining = await this.prisma.mfaRecoveryCode.count({
      where: { userMfaId: record.id, usedAt: null },
    });
    return {
      enabled: Boolean(record.enabledAt),
      pendingEnrolment: !record.enabledAt,
      enabledAt: record.enabledAt,
      recoveryCodesRemaining: remaining,
    };
  }

  /**
   * Issues a fresh secret and the `otpauth://` URI an authenticator app
   * scans. Returns the secret exactly once -- it is stored only encrypted,
   * and no read path returns it again.
   *
   * Refuses when MFA is already enabled: re-enrolling would otherwise let
   * a hijacked session silently swap the second factor to the attacker's
   * device. Disabling first requires the password *and* a current code.
   */
  async startEnrolment(userId: string) {
    const key = this.vaultKey();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        organization: { select: { name: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const existing = await this.prisma.userMfa.findUnique({
      where: { userId },
      select: { enabledAt: true },
    });
    if (existing?.enabledAt) {
      throw new ConflictException(
        'Two-factor authentication is already enabled; disable it first to re-enrol',
      );
    }

    const secret = totp.generateSecret();
    const secretEnc = encryptMfaSecret(secret, key);
    await this.prisma.userMfa.upsert({
      where: { userId },
      create: { userId, secretEnc },
      // Replaces any unconfirmed secret from an abandoned attempt, and
      // clears the replay marker so the new secret starts clean.
      update: { secretEnc, lastUsedStep: null },
    });

    const issuer = user.organization?.name?.trim() || 'MyGymAgent';
    return {
      secret,
      // The label is what the authenticator app shows. An SMS-login
      // member has no email to put there, so the account reads by name
      // rather than as an empty entry.
      // The label is what the authenticator app shows beside the code.
      // An SMS-login member has no email to put there; the account id
      // keeps the entry distinguishable rather than blank.
      otpauthUri: totp.keyuri(user.email ?? user.id, issuer, secret),
    };
  }

  /**
   * Confirms possession of the secret and switches MFA on, returning the
   * recovery codes once. Any codes from a previous enrolment are replaced.
   */
  async confirmEnrolment(userId: string, code: string) {
    const record = await this.prisma.userMfa.findUnique({
      where: { userId },
    });
    if (!record) {
      throw new BadRequestException('Start enrolment before confirming a code');
    }
    if (record.enabledAt) {
      throw new ConflictException(
        'Two-factor authentication is already enabled',
      );
    }

    const step = this.verifyTotp(record.secretEnc, code, record.lastUsedStep);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userMfaId: record.id } });
      await tx.userMfa.update({
        where: { id: record.id },
        data: { enabledAt: new Date(), lastUsedStep: step },
      });
      await tx.mfaRecoveryCode.createMany({
        data: codes.map((value) => ({
          userMfaId: record.id,
          codeHash: hashRecoveryCode(value),
        })),
      });
    });

    return { enabled: true, recoveryCodes: codes };
  }

  /**
   * Turning the second factor off is itself a sensitive action: it needs
   * the password (so a stolen access token alone is not enough) *and* a
   * current code or recovery code (so a stolen password alone is not
   * either).
   */
  async disable(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user?.passwordHash)
      throw new UnauthorizedException('Invalid password');
    const passwordValid = await argon2.verify(user.passwordHash, password);
    if (!passwordValid) throw new UnauthorizedException('Invalid password');

    const record = await this.prisma.userMfa.findUnique({ where: { userId } });
    if (!record?.enabledAt) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    await this.consumeSecondFactor(userId, record, code);
    // Deleting the row (rather than clearing enabledAt) takes the secret
    // and every recovery code with it -- cascade on the FK -- so nothing
    // decryptable survives a disable.
    await this.prisma.userMfa.delete({ where: { id: record.id } });
    return { enabled: false };
  }

  /**
   * The short-lived token handed out when a password check succeeds but a
   * second factor is still owed. Typed `mfa`, never `access`: JwtStrategy
   * rejects any payload whose type is not `access`, so this token cannot
   * be presented as a bearer credential. It is not stored server-side --
   * on its own it grants nothing, and the code it must be paired with is
   * itself replay-protected.
   */
  issueChallengeToken(userId: string): { mfaToken: string; expiresIn: number } {
    const payload: MfaChallengePayload = { sub: userId, type: 'mfa' };
    return {
      mfaToken: this.jwt.sign(payload, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: CHALLENGE_TTL_SECONDS,
      }),
      expiresIn: CHALLENGE_TTL_SECONDS,
    };
  }

  /** Verifies the challenge token and the accompanying code, returning the
   * user id the caller may now issue a real session for. */
  async completeChallenge(mfaToken: string, code: string): Promise<string> {
    let payload: MfaChallengePayload;
    try {
      payload = this.jwt.verify<MfaChallengePayload>(mfaToken, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired verification token');
    }
    if (payload.type !== 'mfa') {
      throw new UnauthorizedException('Invalid or expired verification token');
    }

    const record = await this.prisma.userMfa.findUnique({
      where: { userId: payload.sub },
    });
    if (!record?.enabledAt) {
      throw new UnauthorizedException('Invalid or expired verification token');
    }

    // Re-check account state here rather than only at the password step:
    // the challenge token is valid for five minutes, during which the
    // account may have been suspended, or locked out by code guessing.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, deletedAt: true, lockedUntil: true },
    });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Account temporarily locked due to repeated failed login attempts',
      );
    }

    await this.consumeSecondFactor(payload.sub, record, code);
    await this.prisma.user.update({
      where: { id: payload.sub },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });
    return payload.sub;
  }

  /**
   * Accepts either a TOTP code or an unused recovery code, and burns
   * whichever was used. A wrong code counts against the same lockout
   * budget as a wrong password: 6 digits is a small keyspace, so
   * unlimited guessing would make the second factor decorative.
   */
  private async consumeSecondFactor(
    userId: string,
    record: { id: string; secretEnc: string; lastUsedStep: number | null },
    code: string,
  ): Promise<void> {
    const normalized = code.trim();
    if (!normalized) throw new BadRequestException('A code is required');

    // A recovery code is longer than 6 digits, so the two forms are
    // unambiguous without asking the caller which one they sent.
    if (!/^\d{6}$/.test(normalized.replace(/\s/g, ''))) {
      const consumed = await this.prisma.mfaRecoveryCode.updateMany({
        where: {
          userMfaId: record.id,
          codeHash: hashRecoveryCode(normalized),
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) {
        await this.registerFailedAttempt(userId);
        throw new UnauthorizedException('Invalid verification code');
      }
      return;
    }

    let step: number;
    try {
      step = this.verifyTotp(
        record.secretEnc,
        normalized.replace(/\s/g, ''),
        record.lastUsedStep,
      );
    } catch (error) {
      await this.registerFailedAttempt(userId);
      throw error;
    }
    await this.prisma.userMfa.update({
      where: { id: record.id },
      data: { lastUsedStep: step },
    });
  }

  /**
   * Returns the absolute TOTP step the code matched, so the caller can
   * store it and refuse anything at or below it next time -- without that,
   * a code observed in transit stays replayable for the rest of its own
   * 30-second window.
   */
  private verifyTotp(
    secretEnc: string,
    code: string,
    lastUsedStep: number | null,
  ): number {
    const secret = decryptMfaSecret(secretEnc, this.vaultKey());
    const delta = totp.checkDelta(code, secret);
    if (delta === null) {
      throw new UnauthorizedException('Invalid verification code');
    }
    const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + delta;
    if (lastUsedStep !== null && step <= lastUsedStep) {
      throw new UnauthorizedException(
        'This code has already been used; wait for the next one',
      );
    }
    return step;
  }

  private async registerFailedAttempt(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { failedLoginAttempts: true },
    });
    const attempts = (user?.failedLoginAttempts ?? 0) + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil:
          attempts >= MAX_FAILED_LOGIN_ATTEMPTS
            ? new Date(Date.now() + LOCKOUT_DURATION_MS)
            : undefined,
      },
    });
  }
}
