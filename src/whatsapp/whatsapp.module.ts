import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommunicationsModule } from '../communications/communications.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/**
 * WhatsApp Business integration (one row per org): Meta embedded-signup
 * code exchange with encrypted vault storage, the Meta Cloud API sender
 * (via CommunicationsService), the public inbound/status webhook, the
 * inbound inbox, and the test-send surface. Inbound texts emit
 * `whatsapp.received` on the domain event bus (EventEmitterModule,
 * same import pattern as PtSessionsModule).
 */
@Module({
  imports: [EventEmitterModule, CommunicationsModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
