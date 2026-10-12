import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import { WhatsAppAdapterController } from './whatsapp-adapter.controller';

@Module({
  imports: [PrismaModule],
  providers: [WhatsAppAdapterService],
  controllers: [WhatsAppAdapterController],
  exports: [WhatsAppAdapterService],
})
export class WhatsAppAdapterModule {}
