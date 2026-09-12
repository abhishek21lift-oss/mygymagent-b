import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { MembersModule } from '../members/members.module';
import { CrmController } from './crm.controller';
import { LeadFollowUpsController } from './lead-follow-ups.controller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { WhatsappInboundListener } from './whatsapp-inbound.listener';

/**
 * v1 CRM: the lead pipeline (New -> Contacted -> Qualified -> Trial ->
 * Won/Lost), follow-up tasks, and converting a won lead into a real
 * Member. Campaigns and referrals (also mentioned in the original module
 * README) are deferred -- see README.md.
 */
@Module({
  imports: [MembersModule, CommunicationsModule],
  controllers: [LeadsController, LeadFollowUpsController, CrmController],
  providers: [LeadsService, WhatsappInboundListener],
  exports: [LeadsService],
})
export class CrmModule {}
