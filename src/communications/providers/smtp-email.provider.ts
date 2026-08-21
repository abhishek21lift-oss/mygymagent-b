import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import {
  ChannelNotConfiguredError,
  type EmailMessage,
  type EmailProvider,
} from '../interfaces/email-provider.interface';

/**
 * Real email delivery over SMTP -- works with any mailbox or relay
 * (Gmail/Workspace, a transactional-email provider's SMTP endpoint, a
 * self-hosted relay, or a local dev/test SMTP catcher like smtp-server),
 * not a specific paid vendor's proprietary API. Configuration is checked
 * together at construction time (`SMTP_HOST` present), the same pattern
 * `FileStorageService` uses for S3: unset means every send throws
 * `ChannelNotConfiguredError` rather than the app failing to boot over a
 * missing optional integration.
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly transporter: Transporter | null;
  private readonly fromAddress: string | undefined;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    this.fromAddress = this.config.get<string>('SMTP_FROM_ADDRESS');

    if (!host || !this.fromAddress) {
      this.logger.warn(
        'Email is not fully configured (SMTP_HOST/SMTP_FROM_ADDRESS) -- ' +
          'outbound email will be logged, not sent, and recorded as FAILED in MessageLog.',
      );
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: this.config.get<boolean>('SMTP_SECURE', false),
      auth: this.config.get<string>('SMTP_USER')
        ? {
            user: this.config.get<string>('SMTP_USER'),
            pass: this.config.get<string>('SMTP_PASSWORD'),
          }
        : undefined,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.transporter || !this.fromAddress) {
      this.logger.warn(`[unsent] "${message.subject}" to ${message.to}`);
      throw new ChannelNotConfiguredError(
        'Email is not configured on this deployment (SMTP_HOST/SMTP_FROM_ADDRESS unset).',
      );
    }

    const from = message.fromName
      ? `"${message.fromName}" <${this.fromAddress}>`
      : this.fromAddress;

    await this.transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      replyTo: message.replyTo,
    });
  }
}
