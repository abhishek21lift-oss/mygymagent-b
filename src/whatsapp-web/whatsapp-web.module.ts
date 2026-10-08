import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { WhatsappWebController } from './whatsapp-web.controller';
import { WhatsappWebService } from './whatsapp-web.service';

/**
 * A gym's own WhatsApp number, served by the shared WA-AKG gateway (one
 * session per gym): linking status, QR/pairing passthrough, and sending
 * preferences. The previous in-process Baileys stack was removed; all
 * WhatsApp wire traffic goes through `WaAkgProvider`.
 */
@Module({
  imports: [CommunicationsModule],
  controllers: [WhatsappWebController],
  providers: [WhatsappWebService],
  exports: [WhatsappWebService],
})
export class WhatsappWebModule {}
