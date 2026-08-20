import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Gym operational billing (member payments and refunds) -- NOT platform
 * billing (what a gym pays this SaaS), which is a deliberately separate,
 * not-yet-built model family. See docs/saas/billing-separation.md.
 *
 * Invoices, discounts, taxes, and trainer payouts/commissions described in
 * docs/ARCHITECTURE.md are still not implemented -- this module covers
 * recording a payment and issuing a refund against it, the two actions the
 * existing ACCOUNTANT/SALES_EXECUTIVE/BRANCH_MANAGER role grants
 * (`payments.read`/`payments.create`/`payments.refund`) were already
 * written against.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class BillingModule {}
