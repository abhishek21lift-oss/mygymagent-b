import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { WaAkgProvider } from '../whatsapp/wa-akg.provider';
import { WhatsappInboundFiler } from '../whatsapp/whatsapp-inbound.filer';
import { BaileysSocketFactory } from './baileys-socket.factory';
import { WaSendProcessor } from './wa-send.processor';
import { WaSender } from './wa-sender.service';
import { WaSessionManager } from './wa-session.manager';
import { WhatsappWebController } from './whatsapp-web.controller';
import { WhatsappWebService } from './whatsapp-web.service';
import { WA_SOCKET_FACTORY } from './wa-types';

/**
 * The gym's WhatsApp number, served in-process: live Baileys sessions
 * (manager), paced sends (sender + worker), linking status, and the
 * `WaAkgProvider` the WHATSAPP channel sends through.
 */
@Module({
  imports: [
    EventEmitterModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.WA_SEND }),
  ],
  controllers: [WhatsappWebController],
  providers: [
    WaSessionManager,
    WaSender,
    WaSendProcessor,
    WhatsappWebService,
    WaAkgProvider,
    BaileysSocketFactory,
    WhatsappInboundFiler,
    { provide: WA_SOCKET_FACTORY, useClass: BaileysSocketFactory },
  ],
  exports: [WaSessionManager, WaSender, WaAkgProvider],
})
export class WhatsappWebModule {}
