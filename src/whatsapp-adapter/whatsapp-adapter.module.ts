import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappWebModule } from '../whatsapp-web/whatsapp-web.module';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import { WhatsAppAdapterController } from './whatsapp-adapter.controller';

@Module({
  // WhatsappWebModule owns and exports the single WaSessionManager; importing
  // it here reuses that singleton rather than creating a second manager.
  imports: [PrismaModule, WhatsappWebModule],
  providers: [WhatsAppAdapterService],
  controllers: [WhatsAppAdapterController],
  exports: [WhatsAppAdapterService],
})
export class WhatsAppAdapterModule {}
