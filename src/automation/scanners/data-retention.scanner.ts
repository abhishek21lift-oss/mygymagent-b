import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Scanner for data retention policies.
 * Periodically cleans up old append-only data to prevent unbounded growth:
 * spent and expired credentials, and audit entries past a year. Nothing
 * here may be configuration -- only records of things that happened.
 */
@Injectable()
export class DataRetentionScanner {
  private readonly logger = new Logger(DataRetentionScanner.name);

  constructor(private readonly prisma: PrismaService) {}

  async scan(): Promise<void> {
    this.logger.log('Starting data retention scan...');

    try {
      const RETENTION_PERIODS = {
        auditLog: 365,
        refreshToken: 90,
        passwordResetToken: 7,
        emailVerificationToken: 1,
        webhookDelivery: 30,
      };

      const auditLogCutoff = new Date();
      auditLogCutoff.setDate(
        auditLogCutoff.getDate() - RETENTION_PERIODS.auditLog,
      );
      const deletedAuditLogs = await this.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: auditLogCutoff } },
      });
      this.logger.log(
        `Deleted ${deletedAuditLogs.count} audit log records older than ${RETENTION_PERIODS.auditLog} days`,
      );

      const refreshTokenCutoff = new Date();
      refreshTokenCutoff.setDate(
        refreshTokenCutoff.getDate() - RETENTION_PERIODS.refreshToken,
      );
      const deletedRefreshTokens = await this.prisma.refreshToken.deleteMany({
        where: {
          createdAt: { lt: refreshTokenCutoff },
          revokedAt: { not: null },
        },
      });
      this.logger.log(
        `Deleted ${deletedRefreshTokens.count} refresh token records older than ${RETENTION_PERIODS.refreshToken} days`,
      );

      const passwordResetTokenCutoff = new Date();
      passwordResetTokenCutoff.setDate(
        passwordResetTokenCutoff.getDate() -
          RETENTION_PERIODS.passwordResetToken,
      );
      const deletedPasswordResetTokens =
        await this.prisma.passwordResetToken.deleteMany({
          where: {
            OR: [
              { usedAt: { lt: passwordResetTokenCutoff } },
              { expiresAt: { lt: passwordResetTokenCutoff } },
            ],
          },
        });
      this.logger.log(
        `Deleted ${deletedPasswordResetTokens.count} password reset token records older than ${RETENTION_PERIODS.passwordResetToken} days`,
      );

      // Permission overrides are deliberately NOT here. They are live
      // access control, not history: a DENY set on someone a year ago is
      // still meant to deny today, and deleting it by age would silently
      // hand back access an administrator took away. The model has no
      // expiry for exactly that reason. This scanner deleted them for as
      // long as it existed -- it just never ran until its dispatch was
      // wired, which is when this came out.

      const emailVerificationTokenCutoff = new Date();
      emailVerificationTokenCutoff.setDate(
        emailVerificationTokenCutoff.getDate() -
          RETENTION_PERIODS.emailVerificationToken,
      );
      const deletedEmailVerificationTokens =
        await this.prisma.emailVerificationToken.deleteMany({
          where: {
            OR: [
              { usedAt: { lt: emailVerificationTokenCutoff } },
              { expiresAt: { lt: emailVerificationTokenCutoff } },
            ],
          },
        });
      this.logger.log(
        `Deleted ${deletedEmailVerificationTokens.count} email verification token records older than ${RETENTION_PERIODS.emailVerificationToken} days`,
      );

      const webhookDeliveryCutoff = new Date();
      webhookDeliveryCutoff.setDate(
        webhookDeliveryCutoff.getDate() - RETENTION_PERIODS.webhookDelivery,
      );
      const deletedWebhookDeliveries =
        await this.prisma.webhookDelivery.deleteMany({
          where: { createdAt: { lt: webhookDeliveryCutoff } },
        });
      this.logger.log(
        `Deleted ${deletedWebhookDeliveries.count} webhook delivery records older than ${RETENTION_PERIODS.webhookDelivery} days`,
      );

      this.logger.log('Data retention scan completed successfully');
    } catch (error) {
      this.logger.error('Error during data retention scan', error);
      throw error;
    }
  }
}
