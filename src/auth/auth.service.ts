import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { slugifyWithSuffix } from '../common/utils/slugify';
import { PermissionsService } from '../rbac/permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemberOtpService } from './member-otp.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  TokensService,
} from './tokens.service';
import type { LoginDto } from './dto/login.dto';
import { MfaPolicyService } from './mfa/mfa-policy.service';
import { MfaService } from './mfa/mfa.service';
import type { RegisterDto } from './dto/register.dto';

/** Exported so the MFA second factor reuses this same lockout rather than
 * inventing a parallel one -- a 6-digit code is a small keyspace, so code
 * guessing has to count against the same budget as password guessing. */
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Lazily-computed argon2 hash used only to equalize login timing for
 * unknown emails (see login() below). Computed once, then reused. */
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= argon2.hash(`dummy:${randomUUID()}`);
  return dummyPasswordHash;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  deviceName?: string;
}

function publicUser(user: {
  id: string;
  organizationId: string | null;
  /** Null for a member who signs in by SMS: they were imported with a
   * phone and no address, so there is no email to show them. */
  email: string | null;
  firstName: string;
  lastName: string;
  status: string;
  primaryBranchId: string | null;
  emailVerifiedAt: Date | null;
  /** Set only for platform staff. Absent on the register response, where
   * a just-created account can never have one. */
  platformRole?: 'PLATFORM_OWNER' | 'PLATFORM_ADMIN' | null;
  member?: { id: string } | null;
}) {
  return {
    id: user.id,
    organizationId: user.organizationId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    primaryBranchId: user.primaryBranchId,
    emailVerified: user.emailVerifiedAt !== null,
    /**
     * Platform staff, or null for everyone else.
     *
     * Platform routes are gated server-side on this column rather than on
     * an RBAC grant, so it is the only thing that can tell a client whether
     * to offer the cross-tenant screens at all. Without it the app had no
     * way to know, which is why those screens did not exist.
     */
    platformRole: user.platformRole ?? null,
    /**
     * The gym member this login belongs to, when it is one.
     *
     * The client needs this the instant a session starts, to decide
     * whether to open the staff app or the member portal. Answering it
     * here rather than making every client probe `/portal/me` first
     * keeps the decision on the server, where the link actually lives --
     * and means a member never lands in the staff app, where every
     * request they make would 403.
     */
    memberId: user.member?.id ?? null,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly mfa: MfaService,
    private readonly mfaPolicy: MfaPolicyService,
    private readonly memberOtp: MemberOtpService,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing)
      throw new ConflictException('An account with this email already exists');

    const ownerRole = await this.prisma.role.findFirst({
      where: { key: 'ORG_OWNER', organizationId: null },
    });
    if (!ownerRole) {
      throw new BadRequestException(
        'Platform is not fully initialized: run the seed script before registering.',
      );
    }

    const passwordHash = await argon2.hash(dto.password);
    const slug = slugifyWithSuffix(dto.organizationName);

    const result = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: dto.organizationName, slug, status: 'TRIAL' },
      });

      const branch = await tx.branch.create({
        data: { organizationId: organization.id, name: 'Main', slug: 'main' },
      });

      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          status: 'ACTIVE',
          primaryBranchId: branch.id,
        },
      });

      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: ownerRole.id,
          organizationId: organization.id,
          branchId: null,
        },
      });

      return { organization, branch, user };
    });

    const verificationToken = generateOpaqueToken();
    await this.prisma.emailVerificationToken.create({
      data: {
        userId: result.user.id,
        tokenHash: hashOpaqueToken(verificationToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      },
    });
    // Registration always collects an email -- this path is never a
    // member. The check is for the type, and would be a genuine bug if
    // it ever held.
    await this.communications
      .sendEmailVerification(
        result.organization.id,
        result.user.email ?? '',
        result.user.firstName,
        verificationToken,
      )
      .catch(() => undefined); // best-effort, matches the old MailerService's fire-and-forget shape -- see CommunicationsService's class comment

    await this.audit.record({
      organizationId: result.organization.id,
      actorUserId: result.user.id,
      action: 'register',
      resource: 'organization',
      resourceId: result.organization.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const { accessToken, refreshToken, refreshExpiresAt } =
      await this.issueSession(result.user.id, meta);

    return {
      user: publicUser({ ...result.user, emailVerifiedAt: null }),
      organization: result.organization,
      accessToken,
      refreshToken,
      refreshExpiresAt,
    };
  }

  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      // `member` so the response can say which app this session belongs
      // in -- see publicUser().
      include: { member: { select: { id: true } } },
    });

    // Constant-shaped failure path to avoid leaking whether the email exists.
    // A dummy argon2 verification keeps the response time indistinguishable
    // from a real password mismatch -- without it, unknown emails return
    // immediately while known emails pay the argon2 cost, letting an
    // attacker enumerate accounts by latency.
    if (!user || !user.passwordHash) {
      const dummyHash = await getDummyPasswordHash().catch(() => null);
      if (dummyHash) {
        await argon2.verify(dummyHash, dto.password).catch(() => false);
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      // Same message as password mismatch: a distinct lockout message is an
      // account-existence oracle for attackers enumerating emails.
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      const attempts = user.failedLoginAttempts + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil:
            attempts >= MAX_FAILED_LOGIN_ATTEMPTS
              ? new Date(Date.now() + LOCKOUT_DURATION_MS)
              : undefined,
        },
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('Account is not active');
    }

    // The password is proven, so the guessing budget resets here. Whether
    // the *session* starts depends on the second factor below, so
    // lastLoginAt is only stamped once authentication actually completes.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    if (await this.mfa.isEnabled(user.id)) {
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'login_mfa_challenged',
        resource: 'user',
        resourceId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      // No session, no refresh cookie: the caller holds only a short-lived
      // `mfa`-typed token, which JwtStrategy refuses as a bearer credential.
      return {
        mfaRequired: true as const,
        ...this.mfa.issueChallengeToken(user.id),
      };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'login',
      resource: 'user',
      resourceId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const { accessToken, refreshToken, refreshExpiresAt } =
      await this.issueSession(user.id, meta);

    // A privileged user who has not enrolled still gets a session here.
    // During grace it is a full one and this is only a warning; once the
    // deadline passes JwtStrategy marks every request from it as
    // enrolment-scoped, so the session exists purely to reach the setup
    // screen. Refusing the login instead would lock them out of the one
    // page that fixes it.
    const mfaEnrolment = await this.mfaPolicy.evaluateForUser(user.id);

    return {
      mfaRequired: false as const,
      user: publicUser(user),
      accessToken,
      refreshToken,
      refreshExpiresAt,
      mfaEnrolment: {
        state: mfaEnrolment.state,
        deadline: mfaEnrolment.deadline,
      },
    };
  }

  /**
   * Second half of an MFA login: exchanges the challenge token plus a
   * TOTP/recovery code for a real session. Every account-state check the
   * password path performs is re-run inside `completeChallenge`, since the
   * challenge token outlives the moment the password was checked.
   */
  async completeMfaLogin(mfaToken: string, code: string, meta: RequestMeta) {
    const userId = await this.mfa.completeChallenge(mfaToken, code);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { member: { select: { id: true } } },
    });

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'login_mfa_verified',
      resource: 'user',
      resourceId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const { accessToken, refreshToken, refreshExpiresAt } =
      await this.issueSession(user.id, meta);

    return {
      user: publicUser(user),
      accessToken,
      refreshToken,
      refreshExpiresAt,
      // Someone who just proved a second factor is enrolled by definition.
      // Stated rather than recomputed, and kept in the payload so both
      // halves of a login answer the same shape.
      mfaEnrolment: { state: 'NOT_REQUIRED' as const, deadline: null },
    };
  }

  async refresh(refreshToken: string, meta: RequestMeta) {
    // Atomic rotate-and-revoke (see TokensService.rotateRefreshToken): a
    // replayed token revokes the whole token family instead of silently
    // 401ing, so a stolen refresh token cannot coexist with the victim's
    // session undetected.
    const rotated = await this.tokens.rotateRefreshToken(refreshToken, meta);
    if (!rotated)
      throw new UnauthorizedException('Invalid or expired refresh token');
    if (rotated.reused) {
      await this.audit
        .record({
          organizationId: null,
          actorUserId: rotated.userId,
          action: 'refresh_token_reuse_detected',
          resource: 'user',
          resourceId: rotated.userId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        })
        .catch(() => undefined);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      include: { member: { select: { id: true } } },
    });
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('Account is not active');
    }

    const accessToken = this.tokens.signAccessToken(user.id);

    return {
      user: publicUser(user),
      accessToken,
      refreshToken: rotated.token,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeRefreshToken(refreshToken);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.tokens.revokeAllRefreshTokens(userId);
    await this.audit.record({
      organizationId: null,
      actorUserId: userId,
      action: 'logout_all',
      resource: 'user',
      resourceId: userId,
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { member: { select: { id: true } } },
    });
    const permissions = await this.permissions.getEffectivePermissions(
      user.id,
      user.organizationId,
    );
    // Carried on /auth/me, not just on the login response, so the nudge
    // survives a page reload and a session restored from the refresh
    // cookie -- a deadline the user only ever sees once is no warning.
    const mfaEnrolment = await this.mfaPolicy.evaluateForUser(user.id);
    return {
      user: publicUser(user),
      permissions,
      mfaEnrolment: {
        state: mfaEnrolment.state,
        deadline: mfaEnrolment.deadline,
      },
    };
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always behave the same way whether or not the account exists.
    if (!user) return;

    const token = generateOpaqueToken();
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });
    // A member who signs in by SMS has no address to send this to, and
    // no password to reset either. Silently doing nothing matches the
    // caller's existing contract, which never reveals whether an account
    // was found.
    if (user.email) {
      await this.communications
        .sendPasswordReset(user.organizationId, user.email, token)
        .catch(() => undefined); // best-effort, matches the old MailerService's fire-and-forget shape -- see CommunicationsService's class comment
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: record.userId },
      select: { status: true },
    });

    /**
     * Accepting an invitation activates the account, and nothing else in
     * the codebase ever did.
     *
     * `POST /users` and the member-portal invite both create a user with
     * status INVITED and email them this token. `login()` refuses
     * anything but ACTIVE. So every invited staff member and every
     * invited member could set a password and then be told their
     * credentials were wrong, forever. Twenty e2e suites flipped the
     * status through Prisma to get past it, which is exactly how it
     * stayed invisible.
     *
     * Only INVITED is promoted. A SUSPENDED or DISABLED account
     * resetting its password stays suspended -- a password reset is not
     * a reinstatement, and treating it as one would turn this endpoint
     * into a way around an account being switched off.
     */
    const activating = account.status === 'INVITED';

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          ...(activating
            ? { status: 'ACTIVE', emailVerifiedAt: new Date() }
            : {}),
        },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    // Force re-authentication on every device after a password reset.
    await this.tokens.revokeAllRefreshTokens(record.userId);

    await this.audit.record({
      organizationId: null,
      actorUserId: record.userId,
      action: 'reset_password',
      resource: 'user',
      resourceId: record.userId,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  /**
   * The session half of an SMS login.
   *
   * `MemberOtpService` decides whether the code was right; this turns
   * that into the same session a password login produces, so the portal
   * and every guard downstream cannot tell the two apart.
   *
   * The MFA check is kept rather than skipped. A member account created
   * by this flow has no second factor, so it is normally a no-op -- but
   * if one is ever enrolled on such an account, a login path that
   * ignored it would be a way around it rather than a feature missing
   * from it.
   */
  async loginWithOtp(dto: { phone: string; code: string }, meta: RequestMeta) {
    const { userId } = await this.memberOtp.verifyCode(
      dto.phone,
      dto.code,
      meta,
    );

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { member: { select: { id: true } } },
    });
    if (user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('Account is not active');
    }

    if (await this.mfa.isEnabled(user.id)) {
      return {
        mfaRequired: true as const,
        ...this.mfa.issueChallengeToken(user.id),
      };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0 },
    });

    const { accessToken, refreshToken, refreshExpiresAt } =
      await this.issueSession(user.id, meta);

    return {
      mfaRequired: false as const,
      user: publicUser(user),
      accessToken,
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async issueSession(userId: string, meta: RequestMeta) {
    const accessToken = this.tokens.signAccessToken(userId);
    const { token: refreshToken, expiresAt: refreshExpiresAt } =
      await this.tokens.issueRefreshToken(userId, meta);
    return { accessToken, refreshToken, refreshExpiresAt };
  }
}
