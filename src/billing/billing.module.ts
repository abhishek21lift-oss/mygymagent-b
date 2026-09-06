import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from '../payments/stripe.service';
import { StripeWebhookController } from '../payments/stripe-webhook.controller';
import { OnlinePaymentController } from '../payments/online-payment.controller';

/**
 * Gym operational billing (member payments and refunds) -- NOT platform
 * billing (what a gym pays this SaaS), which is a deliberately separate,
 * not-yet-built model family. See docs/saas/billing-separation.md.
 *
 * Invoices, discounts, taxes, and trainer payouts/commissions described in
 * docs/ARCHITECTURE.md are still not implemented -- this module covers
 * recording a payment, issuing refunds, and the Stripe payment-intent flow.
 */
@Module({
  controllers: [
    PaymentsController,
    OnlinePaymentController,
    StripeWebhookController,
  ],
  providers: [PaymentsService, StripeService],
  exports: [PaymentsService],
})
export class BillingModule {}
