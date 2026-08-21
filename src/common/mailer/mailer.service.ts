import { Injectable, Logger } from '@nestjs/common';

/**
 * Stand-in for the email channel of the future Notifications module
 * (see docs/ARCHITECTURE.md#notification-architecture). It logs instead of
 * sending so auth flows (verify email, reset password) are fully testable
 * today; swap the body of these methods for a real provider call once the
 * Notifications module exists, without touching any caller.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  // eslint-disable-next-line @typescript-eslint/require-await -- kept async: real implementation will await a provider call.
  async sendEmailVerification(to: string, token: string): Promise<void> {
    this.logger.log(`[stub email] Verify email for ${to}: token=${token}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- kept async: real implementation will await a provider call.
  async sendPasswordReset(to: string, token: string): Promise<void> {
    this.logger.log(`[stub email] Password reset for ${to}: token=${token}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- kept async: real implementation will await a provider call.
  async sendWelcomeEmail(to: string, firstName: string): Promise<void> {
    this.logger.log(`[stub email] Welcome email for ${to} (${firstName})`);
  }
}
