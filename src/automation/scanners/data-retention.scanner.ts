import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { JOB_NAMES } from '../queue.constants';
import { Logger } from '@nestjs/common';

/**
 * Scanner for data retention policies.
 * Periodically cleans up old append-only data to prevent unbounded growth.
 */
@Injectable()
export class DataRetentionScanner {
  private readonly logger = new Logger(DataRetentionScanner.name);

  constructor(private readonly prisma: PrismaService) {}

  async scan(): Promise<void> {
    this.logger.log('Starting data retention scan...');

    try {
      // Define retention periods (in days)
      const RETENTION_PERIODS = {
        auditLog: 365, // Keep audit logs for 2 years
        refreshToken: 90, // Keep refresh tokens for 3 months
        passwordResetToken: 7, // Keep password reset tokens for 1 week
        userPermissionOverride: 365, // Keep permission overrides for 2 years
        emailVerificationToken: 1, // Keep email verification tokens for 1 day
      };

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30); // Default 30 days

      // Clean up AuditLog (older than 2 years)
      const auditLogCutoff = new Date();
      auditLogCutoff.setDate(
        auditLogCutoff.getDate() - RETENTION_PERIODS.auditLog,
      );
      const deletedAuditLogs = await this.prisma.auditLog.deleteMany({
        where: {
          createdAt: {
            lt: auditLogCutoff,
          },
        },
      });
      this.logger.log(
        `Deleted ${deletedAuditLogs.count} audit log records older than ${RETENTION_PERIODS.auditLog} days`,
      );

      // Clean up RefreshToken (older than 3 months)
      const refreshTokenCutoff = new Date();
      refreshTokenCutoff.setDate(
        refreshTokenCutoff.getDate() - RETENTION_PERIODS.refreshToken,
      );
      const deletedRefreshTokens = await this.prisma.refreshToken.deleteMany({
        where: {
          createdAt: {
            lt: refreshTokenCutoff,
          },
          revokedAt: {
            not: null,
          }, // Only delete revoked tokens
        },
      });
      this.logger.log(
        `Deleted ${deletedRefreshTokens.count} refresh token records older than ${RETENTION_PERIODS.refreshToken} days`,
      );

      // Clean up PasswordResetToken (older than 1 week)
      const passwordResetTokenCutoff = new Date();
      passwordResetTokenCutoff.setDate(
        passwordResetTokenCutoff.getDate() -
          RETENTION_PERIODS.passwordResetToken,
      );
      const deletedPasswordResetTokens =
        await this.prisma.passwordResetToken.deleteMany({
          where: {
            OR: [
              {
                usedAt: {
                  lt: passwordResetTokenCutoff,
                },
              },
              {
                expiresAt: {
                  lt: passwordResetTokenCutoff,
                },
              },
            ],
          },
        });
      this.logger.log(
        `Deleted ${deletedPasswordResetTokens.count} password reset token records older than ${RETENTION_PERIODS.passwordResetToken} days`,
      );

      // Clean up UserPermissionOverride (older than 2 years)
      const userPermissionOverrideCutoff = new Date();
      userPermissionOverrideCutoff.setDate(
        userPermissionOverrideCutoff.getDate() -
          RETENTION_PERIODS.userPermissionOverride,
      );
      const deletedUserPermissionOverrides =
        await this.prisma.userPermissionOverride.deleteMany({
          where: {
            createdAt: {
              lt: userPermissionOverrideCutoff,
            },
          },
        });
      this.logger.log(
        `Deleted ${deletedUserPermissionOverrides.count} user permission override records older than ${RETENTION_PERIODS.userPermissionOverride} days`,
      );

      // Clean up EmailVerificationToken (older than 1 day)
      const emailVerificationTokenCutoff = new Date();
      emailVerificationTokenCutoff.setDate(
        emailVerificationTokenCutoff.getDate() -
          RETENTION_PERIODS.emailVerificationToken,
      );
      const deletedEmailVerificationTokens =
        await this.prisma.emailVerificationToken.deleteMany({
          where: {
            OR: [
              {
                usedAt: {
                  lt: emailVerificationTokenCutoff,
                },
              },
              {
                expiresAt: {
                  lt: emailVerificationTokenCutoff,
                },
              },
            ],
          },
        });
      this.logger.log(
        `Deleted ${deletedEmailVerificationTokens.count} email verification token records older than ${RETENTION_PERIODS.emailVerificationToken} days`,
      );

      this.logger.log('Data retention scan completed successfully');
    } catch (error) {
      this.logger.error('Error during data retention scan', error);
      throw error;
    }
  }
}
