import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { FollowUpsController } from './follow-ups.controller';
import { FollowUpsService } from './follow-ups.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * CRM: lead pipeline, follow-up workflows, lead conversion, and sales
 * intelligence surfaces. Campaign/referral entities remain intentionally
 * deferred until their domain model is defined rather than being simulated
 * with free-form lead source strings.
 */
@Module({
  imports: [MembersModule],
  controllers: [LeadsController, FollowUpsController],
  providers: [LeadsService, FollowUpsService],
  exports: [LeadsService],
})
export class CrmModule {}
