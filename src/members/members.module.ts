import { Module } from '@nestjs/common';
import { MemberDetailsController } from './member-details.controller';
import { MemberDetailsService } from './member-details.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  controllers: [MembersController, MemberDetailsController],
  providers: [MembersService, MemberDetailsService],
  exports: [MembersService],
})
export class MembersModule {}
