import { Module } from '@nestjs/common';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { MembershipLifecycleService } from './membership-lifecycle.service';

@Module({
  controllers: [MembershipsController],
  providers: [MembershipsService, MembershipLifecycleService],
  exports: [MembershipsService, MembershipLifecycleService],
})
export class MembershipsModule {}
