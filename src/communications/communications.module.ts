/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommunicationsController } from './communications.controller';
import {
  CommunicationsService,
  EMAIL_PROVIDER,
  PUSH_PROVIDER,
  SMS_PROVIDER,
  WHATSAPP_PROVIDER,
} from './communications.service';
import { MessageTemplateService } from './message-template.service';
import { MetaWhatsappProvider } from './providers/meta-whatsapp.provider';
import { Msg91SmsProvider } from './providers/msg91-sms.provider';
import { HttpChannelProvider } from './providers/http-channel.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

/**
 * Real, provider-backed communications -- see README.md for what's built
 * (EMAIL, WHATSAPP via the Meta Cloud API, real templates, per-org
 * branding, MARKETING-consent enforcement, delivery logging) vs.
 * deliberately not yet (SMS/PUSH have no real provider; the bound
 * `UnimplementedChannelProvider` always throws rather than silently
 * no-opping).
 *
 * `@Global()` is deliberately NOT used here (unlike QueueModule/FilesModule)
 * -- CommunicationsService is a substantial, feature-specific API surface,
 * not small shared infrastructure; modules that need it import this one
 * explicitly, the same way AiModule imports MembersModule.
 */
@Module({
  controllers: [CommunicationsController],
  providers: [
    CommunicationsService,
    MessageTemplateService,
    MetaWhatsappProvider,
    Msg91SmsProvider,
    { provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider },
    {
      provide: WHATSAPP_PROVIDER,
      useClass: MetaWhatsappProvider,
    },
    // MSG91 rather than the generic HttpChannelProvider: SMS on this
    // deployment is an Indian, DLT-registered channel, which is a shape
    // the generic "POST {to, text} to a URL" provider cannot express.
    // PUSH keeps the generic one until a real provider lands.
    {
      provide: SMS_PROVIDER,
      useClass: Msg91SmsProvider,
    },
    {
      provide: PUSH_PROVIDER,
      useFactory: (config: ConfigService) =>
        new HttpChannelProvider(config, 'PUSH'),
      inject: [ConfigService],
    },
  ],
  exports: [CommunicationsService, Msg91SmsProvider],
})
export class CommunicationsModule {}
