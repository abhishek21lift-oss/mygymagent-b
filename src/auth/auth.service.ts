import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../common/mailer/mailer.service';
import { slugifyWithSuffix } from '../common/utils/slugify';
import { PermissionsService } from '../rbac/permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  TokensService,
} from './tokens.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  deviceName?: string;
}

function publicUser(user: {
  id: string;
  organizationId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  primaryBranchId: string | null;
  emailVerifiedAt: Date | null;
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
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
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
    await this.mailer.sendEmailVerification(
      result.user.email,
      verificationToken,
    );

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
    });

    // Constant-shaped failure path to avoid leaking whether the email exists.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Account temporarily locked due to repeated failed login attempts',
      );
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

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
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

    return {
      user: publicUser(user),
      accessToken,
      refreshToken,
      refreshExpiresAt,
    };
  }

  async refresh(refreshToken: string, meta: RequestMeta) {
    const record = await this.tokens.findValidRefreshToken(refreshToken);
    if (!record)
      throw new UnauthorizedException('Invalid or expired refresh token');

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('Account is not active');
    }

    // Rotate: revoke the presented token and issue a fresh pair.
    await this.tokens.revokeRefreshToken(refreshToken);
    const {
      accessToken,
      refreshToken: newRefreshToken,
      refreshExpiresAt,
    } = await this.issueSession(user.id, meta);

    return {
      user: publicUser(user),
      accessToken,
      refreshToken: newRefreshToken,
      refreshExpiresAt,
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
    });
    const permissions = await this.permissions.getEffectivePermissions(
      user.id,
      user.organizationId,
    );
    return { user: publicUser(user), permissions };
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
    await this.mailer.sendPasswordReset(user.email, token);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
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

  private async issueSession(userId: string, meta: RequestMeta) {
    const accessToken = this.tokens.signAccessToken(userId);
    const { token: refreshToken, expiresAt: refreshExpiresAt } =
      await this.tokens.issueRefreshToken(userId, meta);
    return { accessToken, refreshToken, refreshExpiresAt };
  }
}
