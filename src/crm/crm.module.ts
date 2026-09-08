import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { MembersModule } from '../members/members.module';
import { FollowUpsController } from './follow-ups.controller';
import { FollowUpsService } from './follow-ups.service';
import { LeadScoringService } from './lead-scoring.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * CRM: lead pipeline, follow-up workflows, lead conversion, lead scoring,
 * lead outreach messaging, and sales intelligence surfaces. Campaign/
 * referral entities remain intentionally deferred until their domain
 * model is defined rather than being simulated with free-form lead
 * source strings.
 */
@Module({
  imports: [MembersModule, CommunicationsModule],
  controllers: [LeadsController, FollowUpsController],
  providers: [LeadsService, FollowUpsService, LeadScoringService],
  exports: [LeadsService, LeadScoringService],
})
export class CrmModule {}
