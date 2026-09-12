import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { RazorpayController } from '../payments/razorpay.controller';
import { RazorpayService } from '../payments/razorpay.service';
import { BillingAgingController } from './billing-aging.controller';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { MembershipInvoiceListener } from './membership-invoice.listener';

/**
 * WS-1 accounts receivable: raising/issuing invoices, voiding them,
 * collecting them online (Razorpay), and aging the outstanding book.
 *
 * Razorpay's controller/service live in src/payments/ but are registered
 * here rather than in BillingModule: the webhook's capture path needs
 * InvoicesService (link + recompute + receipt) and retry-collection needs
 * RazorpayService, so housing both sides in one module avoids a
 * BillingModule <-> InvoicesModule cycle.
 */
@Module({
  imports: [CommunicationsModule],
  controllers: [InvoicesController, BillingAgingController, RazorpayController],
  providers: [InvoicesService, RazorpayService, MembershipInvoiceListener],
  exports: [InvoicesService, RazorpayService],
})
export class InvoicesModule {}
