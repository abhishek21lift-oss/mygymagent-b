import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * v1 CRM: the lead pipeline (New -> Contacted -> Qualified -> Trial ->
 * Won/Lost), follow-up tasks, and converting a won lead into a real
 * Member. Campaigns and referrals (also mentioned in the original module
 * README) are deferred -- see README.md.
 */
@Module({
  imports: [MembersModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class CrmModule {}
