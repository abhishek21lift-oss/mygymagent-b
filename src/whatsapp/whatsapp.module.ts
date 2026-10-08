import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommunicationsModule } from '../communications/communications.module';
import { MemberIntelligenceModule } from '../member-intelligence/member-intelligence.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { BroadcastService } from './broadcast.service';
import { AutoRepliesController } from './auto-replies.controller';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhooksController } from './webhooks.controller';
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
    MemberIntelligenceModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.WA_SCHEDULED }),
    BullModule.registerQueue({ name: QUEUE_NAMES.WA_WEBHOOKS }),
  ],
  controllers: [WhatsappController, AutoRepliesController, WebhooksController],
  providers: [
    WhatsappService,
    WhatsappInboundFiler,
    ScheduledMessageService,
    ScheduledMessageProcessor,
    BroadcastService,
    WebhookDispatcherService,
    WebhookDeliveryProcessor,
  ],
  // BullModule re-exported so the Command Center reads this module's
  // `wa-scheduled` Queue instance rather than registering a duplicate.
  exports: [
    BullModule,
    WhatsappService,
    ScheduledMessageService,
    BroadcastService,
  ],
})
export class WhatsappModule {}
