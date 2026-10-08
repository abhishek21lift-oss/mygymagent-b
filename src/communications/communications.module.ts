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
import { WaAkgProvider } from '../whatsapp/wa-akg.provider';
import { Msg91SmsProvider } from './providers/msg91-sms.provider';
import { FcmPushProvider } from './providers/fcm-push.provider';
import { HttpChannelProvider } from './providers/http-channel.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

/**
 * Real, provider-backed communications -- see README.md for what's built
 * (EMAIL, WHATSAPP via the Meta Cloud API, real templates, per-org
 * branding, MARKETING-consent enforcement, delivery logging) vs.
 * SMS via MSG91, PUSH via FCM). An unconfigured provider throws rather
 * than silently no-opping, so the failure lands in MessageLog.
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
    WaAkgProvider,
    Msg91SmsProvider,
    FcmPushProvider,
    { provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider },
    // Shared WA-AKG gateway, one session per gym (see WaAkgProvider).
    {
      provide: WHATSAPP_PROVIDER,
      useClass: WaAkgProvider,
    },
    // MSG91 rather than the generic HttpChannelProvider: SMS on this
    // deployment is an Indian, DLT-registered channel, which is a shape
    // the generic "POST {to, text} to a URL" provider cannot express.
    {
      provide: SMS_PROVIDER,
      useClass: Msg91SmsProvider,
    },
    // FCM when a service account is configured (B-P1-1). Otherwise the
    // generic HTTP relay, so a deployment that pointed PUSH_PROVIDER_URL
    // at its own relay keeps working exactly as before.
    {
      provide: PUSH_PROVIDER,
      useFactory: (config: ConfigService, fcm: FcmPushProvider) =>
        fcm.isConfigured() ? fcm : new HttpChannelProvider(config, 'PUSH'),
      inject: [ConfigService, FcmPushProvider],
    },
  ],
  exports: [
    CommunicationsService,
    Msg91SmsProvider,
    FcmPushProvider,
    WaAkgProvider,
  ],
})
export class CommunicationsModule {}
