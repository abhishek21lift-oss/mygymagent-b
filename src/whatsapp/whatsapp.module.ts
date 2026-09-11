import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/**
 * WhatsApp Business integration (one row per org): Meta embedded-signup
 * code exchange, WABA metadata storage, and the message history/send
 * surface. Outbound delivery reuses CommunicationsService -- see
 * WhatsappService for what sends for real today vs. what records a
 * clear failure until the Cloud API provider + credential vault exist.
 */
@Module({
  imports: [CommunicationsModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
