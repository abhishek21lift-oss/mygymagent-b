import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { MemberIntelligenceModule } from '../member-intelligence/member-intelligence.module';
import { AutomationController } from './automation.controller';
import { AutomationOverviewService } from './automation-overview.service';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AutomationRunService } from './automation-run.service';
import { MemberMessenger } from './member-messenger.service';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationScanProcessor } from './automation-scan.processor';
import { InventoryLowListener } from './inventory-low.listener';
import { PaymentReceiptListener } from './payment-receipt.listener';
import { LeadFollowupScanner } from './scanners/lead-followup.scanner';
import { LeadFirstTouchScanner } from './scanners/lead-first-touch.scanner';
import { QrRotationScanner } from './scanners/qr-rotation.scanner';
import { MemberInactiveScanner } from './scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from './scanners/membership-renewal.scanner';
import { MembershipStatusScanner } from './scanners/membership-status.scanner';
import { PaymentOverdueScanner } from './scanners/payment-overdue.scanner';
import { DataRetentionScanner } from './scanners/data-retention.scanner';
import { InvoiceDunningScanner } from './scanners/invoice-dunning.scanner';
import { PtExpiryScanner } from './scanners/pt-expiry.scanner';
import { WhatsappAutoReplyListener } from './whatsapp-auto-reply.listener';
import { StaffReplyListener } from './staff-reply.listener';

import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.AUTOMATION }),
    CommunicationsModule,
    MemberIntelligenceModule,
    NotificationsModule,
  ],
  controllers: [AutomationController],
  // See the note in notifications.module.ts: re-exported so the Command
  // Center reads this module's Queue instance rather than a duplicate.
  providers: [
    AutomationOverviewService,
    AutomationRunService,
    MemberMessenger,
    AutomationSchedulerService,
    AutomationScanProcessor,
    InventoryLowListener,
    PaymentReceiptListener,
    MembershipRenewalScanner,
    MembershipStatusScanner,
    PaymentOverdueScanner,
    MemberInactiveScanner,
    LeadFollowupScanner,
    LeadFirstTouchScanner,
    QrRotationScanner,
    DataRetentionScanner,
    InvoiceDunningScanner,
    PtExpiryScanner,
    WhatsappAutoReplyListener,
    StaffReplyListener,
  ],
  exports: [BullModule],
})
export class AutomationModule {}
