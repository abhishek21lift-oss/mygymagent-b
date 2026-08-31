import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { PtPackagesModule } from '../pt-packages/pt-packages.module';
import { PtSessionsController } from './pt-sessions.controller';
import { PtSessionsService } from './pt-sessions.service';

@Module({
  imports: [EventEmitterModule, PtPackagesModule],
  controllers: [PtSessionsController],
  providers: [PtSessionsService, PrismaService],
  exports: [PtSessionsService],
})
export class PtSessionsModule {}
