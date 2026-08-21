import { Module } from '@nestjs/common';
import {
  CommunicationsService,
  EMAIL_PROVIDER,
  PUSH_PROVIDER,
  SMS_PROVIDER,
  WHATSAPP_PROVIDER,
} from './communications.service';
import { MessageTemplateService } from './message-template.service';
import { UnimplementedChannelProvider } from './interfaces/message-provider.interface';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

/**
 * Real, provider-backed communications -- see README.md for what's built
 * (EMAIL, real templates, per-org branding, MARKETING-consent enforcement,
 * delivery logging) vs. deliberately not yet (WHATSAPP/SMS/PUSH have no
 * real provider; the bound `UnimplementedChannelProvider` always throws
 * rather than silently no-opping).
 *
 * `@Global()` is deliberately NOT used here (unlike QueueModule/FilesModule)
 * -- CommunicationsService is a substantial, feature-specific API surface,
 * not small shared infrastructure; modules that need it import this one
 * explicitly, the same way AiModule imports MembersModule.
 */
@Module({
  providers: [
    CommunicationsService,
    MessageTemplateService,
    { provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider },
    {
      provide: WHATSAPP_PROVIDER,
      useValue: new UnimplementedChannelProvider('WhatsApp'),
    },
    {
      provide: SMS_PROVIDER,
      useValue: new UnimplementedChannelProvider('SMS'),
    },
    {
      provide: PUSH_PROVIDER,
      useValue: new UnimplementedChannelProvider('Push'),
    },
  ],
  exports: [CommunicationsService],
})
export class CommunicationsModule {}
