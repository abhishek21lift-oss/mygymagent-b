import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
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

interface SendInput { organizationId: string | null; channel: CommunicationChannel; category: MessageCategory; templateKey: string; recipient: string; memberId?: string; variables?: Record<string, string>; }

@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);
  constructor(private readonly prisma: PrismaService, private readonly templates: MessageTemplateService, private readonly config: ConfigService, @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider, @Inject(WHATSAPP_PROVIDER) private readonly whatsappProvider: MessageProvider, @Inject(SMS_PROVIDER) private readonly smsProvider: MessageProvider, @Inject(PUSH_PROVIDER) private readonly pushProvider: MessageProvider) {}

  async send(input: SendInput) {
    const organization = input.organizationId ? await this.prisma.organization.findUnique({ where: { id: input.organizationId }, select: { name: true, emailFromName: true, emailReplyTo: true } }) : null;
    const variables = { organizationName: organization?.name ?? '', ...input.variables };
    if (input.category === 'MARKETING' && input.memberId) {
      if (!input.organizationId) throw new BadRequestException('organizationId is required for MARKETING sends targeting a member');
      const consent = await this.prisma.memberConsent.findFirst({ where: { organizationId: input.organizationId, memberId: input.memberId, type: 'MARKETING' }, orderBy: { createdAt: 'desc' } });
      if (!consent?.granted) return this.prisma.messageLog.create({ data: { organizationId: input.organizationId, channel: input.channel, category: input.category, templateKey: input.templateKey, recipient: input.recipient, memberId: input.memberId, status: 'SKIPPED_NO_CONSENT' } });
    }
    const template = await this.templates.resolve(input.organizationId, input.templateKey, input.channel);
    const subject = template.subject ? this.templates.render(template.subject, variables) : undefined;
    const body = this.templates.render(template.body, variables);
    const log = await this.prisma.messageLog.create({ data: { organizationId: input.organizationId, channel: input.channel, category: input.category, templateKey: input.templateKey, recipient: input.recipient, memberId: input.memberId, status: 'PENDING' } });
    try {
      if (input.channel === 'EMAIL') await this.emailProvider.send({ to: input.recipient, subject: subject ?? '', text: body, fromName: organization?.emailFromName ?? undefined, replyTo: organization?.emailReplyTo ?? undefined });
      else {
        if (!input.organizationId) throw new BadRequestException('organizationId is required for non-email studio messaging');
        const provider = { WHATSAPP: this.whatsappProvider, SMS: this.smsProvider, PUSH: this.pushProvider }[input.channel];
        await provider.send({ organizationId: input.organizationId, to: input.recipient, text: body });
      }
      return this.prisma.messageLog.update({ where: { id: log.id }, data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to send ${input.channel} "${input.templateKey}" to ${input.recipient}: ${errorMessage}`);
      await this.prisma.messageLog.update({ where: { id: log.id }, data: { status: 'FAILED', attempts: { increment: 1 }, errorMessage } });
      throw error;
    }
  }
  private frontendUrl(): string { return this.config.get<string>('FRONTEND_URL', 'http://localhost:3000'); }
  sendWelcomeEmail(organizationId: string, to: string, firstName: string, memberId?: string) { return this.send({ organizationId, channel: 'EMAIL', category: 'TRANSACTIONAL', templateKey: 'welcome_email', recipient: to, memberId, variables: { firstName } }); }
  sendEmailVerification(organizationId: string, to: string, firstName: string, token: string) { return this.send({ organizationId, channel: 'EMAIL', category: 'TRANSACTIONAL', templateKey: 'email_verification', recipient: to, variables: { firstName, token } }); }
  sendPasswordReset(organizationId: string | null, to: string, token: string) { return this.send({ organizationId, channel: 'EMAIL', category: 'TRANSACTIONAL', templateKey: 'password_reset', recipient: to, variables: { resetUrl: `${this.frontendUrl()}/reset-password?token=${token}` } }); }
  sendStaffInvite(organizationId: string, to: string, firstName: string, token: string) { return this.send({ organizationId, channel: 'EMAIL', category: 'TRANSACTIONAL', templateKey: 'staff_invite', recipient: to, variables: { firstName, resetUrl: `${this.frontendUrl()}/reset-password?token=${token}` } }); }
  sendMembershipRenewalReminder(organizationId: string, memberId: string, to: string, variables: { firstName: string; planName: string; expiryDate: string }) { return this.send({ organizationId, channel: 'EMAIL', category: 'TRANSACTIONAL', templateKey: 'membership_renewal_reminder', recipient: to, memberId, variables }); }
}
