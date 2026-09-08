import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AutomationRunService } from './automation-run.service';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationScanProcessor } from './automation-scan.processor';
import { InventoryLowListener } from './inventory-low.listener';
import { LeadFollowupScanner } from './scanners/lead-followup.scanner';
import { AppointmentReminderScanner } from './scanners/appointment-reminder.scanner';
import { MemberInactiveScanner } from './scanners/member-inactive.scanner';
import { MembershipExpiryScanner } from './scanners/membership-expiry.scanner';
import { MembershipRenewalScanner } from './scanners/membership-renewal.scanner';
import { PaymentOverdueScanner } from './scanners/payment-overdue.scanner';
import { DataRetentionScanner } from './scanners/data-retention.scanner';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.AUTOMATION }),
    CommunicationsModule,
    MembershipsModule,
  ],
  providers: [
    AutomationRunService,
    AutomationSchedulerService,
    AutomationScanProcessor,
    InventoryLowListener,
    MembershipRenewalScanner,
    MembershipExpiryScanner,
    PaymentOverdueScanner,
    MemberInactiveScanner,
    LeadFollowupScanner,
    AppointmentReminderScanner,
    DataRetentionScanner,
  ],
})
export class AutomationModule {}
