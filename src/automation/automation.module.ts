import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AutomationRunService } from './automation-run.service';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationScanProcessor } from './automation-scan.processor';
import { InventoryLowListener } from './inventory-low.listener';
import { LeadFollowupScanner } from './scanners/lead-followup.scanner';
import { MemberInactiveScanner } from './scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from './scanners/membership-renewal.scanner';
import { PaymentOverdueScanner } from './scanners/payment-overdue.scanner';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.AUTOMATION }),
    CommunicationsModule,
  ],
  providers: [
    AutomationRunService,
    AutomationSchedulerService,
    AutomationScanProcessor,
    InventoryLowListener,
    MembershipRenewalScanner,
    PaymentOverdueScanner,
    MemberInactiveScanner,
    LeadFollowupScanner,
  ],
})
export class AutomationModule {}
