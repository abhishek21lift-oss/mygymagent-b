import { Module } from '@nestjs/common';
import { CommunicationsService, EMAIL_PROVIDER, PUSH_PROVIDER, SMS_PROVIDER, WHATSAPP_PROVIDER } from './communications.service';
import { MessageTemplateService } from './message-template.service';
import { UnimplementedChannelProvider } from './interfaces/message-provider.interface';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { MetaWhatsAppProvider } from './providers/meta-whatsapp.provider';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsAppModule],
  providers: [
    CommunicationsService,
    MessageTemplateService,
    { provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider },
    { provide: WHATSAPP_PROVIDER, useClass: MetaWhatsAppProvider },
    { provide: SMS_PROVIDER, useValue: new UnimplementedChannelProvider('SMS') },
    { provide: PUSH_PROVIDER, useValue: new UnimplementedChannelProvider('Push') },
  ],
  exports: [CommunicationsService],
})
export class CommunicationsModule {}
