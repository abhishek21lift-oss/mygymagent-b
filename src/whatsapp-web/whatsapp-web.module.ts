import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { WhatsappInboundFiler } from '../whatsapp/whatsapp-inbound.filer';
import { BaileysSocketFactory } from './baileys-socket.factory';
import { WhatsappWebController } from './whatsapp-web.controller';
import { WhatsappWebManager } from './whatsapp-web.manager';
import { WhatsappWebProcessor } from './whatsapp-web.processor';
import { WhatsappWebSender } from './whatsapp-web.sender';
import { WhatsappWebService } from './whatsapp-web.service';
import { WA_SOCKET_FACTORY } from './whatsapp-web.types';

/**
 * WhatsApp Web through Baileys: a gym links its own number and the
 * WHATSAPP channel can send through it instead of the Meta Cloud API.
 * Deliberately depends on nothing in CommunicationsModule, which imports
 * this one for the sender.
 */
@Module({
  imports: [
    EventEmitterModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.WHATSAPP_WEB }),
  ],
  controllers: [WhatsappWebController],
  providers: [
    WhatsappWebManager,
    WhatsappWebSender,
    WhatsappWebService,
    WhatsappWebProcessor,
    WhatsappInboundFiler,
    { provide: WA_SOCKET_FACTORY, useClass: BaileysSocketFactory },
  ],
  // See the note in notifications.module.ts.
  exports: [WhatsappWebSender, WhatsappWebManager, BullModule],
})
export class WhatsappWebModule {}
