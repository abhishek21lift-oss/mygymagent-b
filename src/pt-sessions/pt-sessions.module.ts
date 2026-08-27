import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MembersService } from '../members/members.service';
import { StaffProfilesService } from '../staff-profiles/staff-profiles.service';
import { BranchesService } from '../branches/branches.service';
import { PrismaService } from '../prisma/prisma.service';
import { PtSessionsController } from './pt-sessions.controller';
import { PtSessionsService } from './pt-sessions.service';

@Module({
  imports: [EventEmitterModule],
  controllers: [PtSessionsController],
  providers: [
    PtSessionsService,
    MembersService,
    StaffProfilesService,
    BranchesService,
    PrismaService,
  ],
  exports: [PtSessionsService],
})
export class PtSessionsModule {}