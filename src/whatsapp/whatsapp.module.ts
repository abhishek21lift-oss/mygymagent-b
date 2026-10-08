import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommunicationsModule } from '../communications/communications.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { ScheduledMessageProcessor } from './scheduled-message.processor';
import { ScheduledMessageService } from './scheduled-message.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappInboundFiler } from './whatsapp-inbound.filer';

/**
 * WhatsApp messaging surfaces: sends, logs, templates, the inbound
 * inbox, and staff-composed scheduled messages (stored rows fired by a
 * delayed job). Inbound texts emit `whatsapp.received` on the domain
 * event bus (EventEmitterModule, same import pattern as PtSessionsModule).
 */
@Module({
  imports: [
    EventEmitterModule,
    CommunicationsModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.WA_SCHEDULED }),
  ],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappInboundFiler,
    ScheduledMessageService,
    ScheduledMessageProcessor,
  ],
  exports: [WhatsappService, ScheduledMessageService],
})
export class WhatsappModule {}
