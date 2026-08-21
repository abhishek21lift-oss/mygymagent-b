import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CommunicationChannel, MessageCategory } from '@prisma/client';
import type { EmailProvider } from './interfaces/email-provider.interface';
import type { MessageProvider } from './interfaces/message-provider.interface';
import { MessageTemplateService } from './message-template.service';
import { PrismaService } from '../prisma/prisma.service';

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

interface SendInput {
  /** Null for a platform admin (User.organizationId: null) triggering
   * their own send, e.g. a password reset -- mirrors AuditService.record()'s
   * nullable organizationId for the same reason. */
  organizationId: string | null;
  channel: CommunicationChannel;
  category: MessageCategory;
  templateKey: string;
  recipient: string;
  memberId?: string;
  variables?: Record<string, string>;
}

/**
 * The one place in the codebase that turns "send this kind of message to
 * this person" into an actual outbound attempt -- template resolution
 * (org override or system default), per-org branding, consent
 * enforcement, delivery logging, and provider dispatch, in that order.
 * See README.md for what's real (EMAIL, via SmtpEmailProvider) vs. typed
 * but unimplemented (WHATSAPP/SMS/PUSH).
 *
 * Callers fall into two shapes:
 *  - Synchronous, time-sensitive transactional flows (password reset,
 *    email verification) call `send()`/the convenience wrappers directly
 *    and await the result -- a failure here is the caller's to handle
 *    (e.g. AuthService still completes forgotPassword() even if the send
 *    fails, matching the old MailerService's fire-and-forget shape, but
 *    now the failure is recorded in MessageLog instead of only a log line).
 *  - Anything queued (the welcome email today; future automation-engine
 *    actions) calls `send()` from inside a BullMQ job processor, so a
 *    thrown error gets the queue's own retry/backoff for free -- see
 *    queue.module.ts's defaultJobOptions.
 */
@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: MessageTemplateService,
    private readonly config: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    @Inject(WHATSAPP_PROVIDER)
    private readonly whatsappProvider: MessageProvider,
    @Inject(SMS_PROVIDER) private readonly smsProvider: MessageProvider,
    @Inject(PUSH_PROVIDER) private readonly pushProvider: MessageProvider,
  ) {}

  async send(input: SendInput) {
    const organization = input.organizationId
      ? await this.prisma.organization.findUnique({
          where: { id: input.organizationId },
          select: { name: true, emailFromName: true, emailReplyTo: true },
        })
      : null;
    const variables = {
      organizationName: organization?.name ?? '',
      ...input.variables,
    };

    if (input.category === 'MARKETING' && input.memberId) {
      // A MARKETING send always targets a member, and every Member belongs
      // to an organization -- a null organizationId here means the caller
      // built the input wrong, not a legitimate platform-admin case (those
      // are transactional, e.g. password reset, and never carry a memberId).
      if (!input.organizationId) {
        throw new BadRequestException(
          'organizationId is required for MARKETING sends targeting a member',
        );
      }
      const consent = await this.prisma.memberConsent.findFirst({
        where: {
          organizationId: input.organizationId,
          memberId: input.memberId,
          type: 'MARKETING',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!consent?.granted) {
        return this.prisma.messageLog.create({
          data: {
            organizationId: input.organizationId,
            channel: input.channel,
            category: input.category,
            templateKey: input.templateKey,
            recipient: input.recipient,
            memberId: input.memberId,
            status: 'SKIPPED_NO_CONSENT',
          },
        });
      }
    }

    const template = await this.templates.resolve(
      input.organizationId,
      input.templateKey,
      input.channel,
    );
    const subject = template.subject
      ? this.templates.render(template.subject, variables)
      : undefined;
    const body = this.templates.render(template.body, variables);

    const log = await this.prisma.messageLog.create({
      data: {
        organizationId: input.organizationId,
        channel: input.channel,
        category: input.category,
        templateKey: input.templateKey,
        recipient: input.recipient,
        memberId: input.memberId,
        status: 'PENDING',
      },
    });

    try {
      if (input.channel === 'EMAIL') {
        await this.emailProvider.send({
          to: input.recipient,
          subject: subject ?? '',
          text: body,
          fromName: organization?.emailFromName ?? undefined,
          replyTo: organization?.emailReplyTo ?? undefined,
        });
      } else {
        const provider = {
          WHATSAPP: this.whatsappProvider,
          SMS: this.smsProvider,
          PUSH: this.pushProvider,
        }[input.channel];
        await provider.send({ to: input.recipient, text: body });
      }
      return this.prisma.messageLog.update({
        where: { id: log.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to send ${input.channel} "${input.templateKey}" to ${input.recipient}: ${errorMessage}`,
      );
      await this.prisma.messageLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', attempts: { increment: 1 }, errorMessage },
      });
      throw error;
    }
  }

  private frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
  }

  // -- Transactional convenience wrappers, replacing the old MailerService --

  sendWelcomeEmail(
    organizationId: string,
    to: string,
    firstName: string,
    memberId?: string,
  ) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'welcome_email',
      recipient: to,
      memberId,
      variables: { firstName },
    });
  }

  sendEmailVerification(
    organizationId: string,
    to: string,
    firstName: string,
    token: string,
  ) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'email_verification',
      recipient: to,
      variables: { firstName, token },
    });
  }

  sendPasswordReset(organizationId: string | null, to: string, token: string) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'password_reset',
      recipient: to,
      variables: {
        resetUrl: `${this.frontendUrl()}/reset-password?token=${token}`,
      },
    });
  }

  sendStaffInvite(
    organizationId: string,
    to: string,
    firstName: string,
    token: string,
  ) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'staff_invite',
      recipient: to,
      variables: {
        firstName,
        resetUrl: `${this.frontendUrl()}/reset-password?token=${token}`,
      },
    });
  }

  // -- Automation-engine actions (src/automation/) --

  sendMembershipRenewalReminder(
    organizationId: string,
    memberId: string,
    to: string,
    variables: { firstName: string; planName: string; expiryDate: string },
  ) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'membership_renewal_reminder',
      recipient: to,
      memberId,
      variables,
    });
  }

  sendPaymentOverdueReminder(
    organizationId: string,
    memberId: string,
    to: string,
    variables: { firstName: string; amount: string; currency: string },
  ) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'payment_overdue_reminder',
      recipient: to,
      memberId,
      variables,
    });
  }

  sendInactiveMemberRecovery(
    organizationId: string,
    memberId: string,
    to: string,
    variables: { firstName: string; daysInactive: string },
  ) {
    // Marketing-adjacent re-engagement, not an operational necessity like
    // the reminders above -- gated by MARKETING consent in send().
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'MARKETING',
      templateKey: 'member_inactive_recovery',
      recipient: to,
      memberId,
      variables,
    });
  }

  sendLeadFollowupReminder(
    organizationId: string,
    to: string,
    variables: { leadName: string; dueDate: string; note: string },
  ) {
    // Sent to staff (the assigned salesperson), not a member -- no
    // memberId, no consent gate.
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'lead_followup_reminder',
      recipient: to,
      variables,
    });
  }

  sendLowStockAlert(
    organizationId: string,
    to: string,
    variables: {
      productName: string;
      sku: string;
      quantityOnHand: string;
      reorderLevel: string;
    },
  ) {
    return this.send({
      organizationId,
      channel: 'EMAIL',
      category: 'TRANSACTIONAL',
      templateKey: 'low_stock_alert',
      recipient: to,
      variables,
    });
  }
}
