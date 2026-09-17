import {
  Controller,
  Post,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import type Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { Logger } from '@nestjs/common';
import { PaymentsService } from '../billing/payments.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('payments/webhook')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  constructor(
    private readonly config: ConfigService,
    private readonly stripeService: StripeService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      this.logger.error('Stripe webhook secret not configured');
      throw new ServiceUnavailableException('Webhook secret not configured');
    }

    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    try {
      // Stripe signs the raw bytes — re-serializing the parsed body would
      // change whitespace/key order and break verification. main.ts sets
      // `rawBody: true`, so prefer req.rawBody and only fall back to
      // JSON.stringify when the raw buffer is unavailable (same pattern as
      // RazorpayController).
      const rawBody: Buffer =
        req.rawBody ??
        Buffer.from(JSON.stringify((req as Request & { body?: unknown }).body ?? {}));
      const event = await this.stripeService.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );

      // Handle the event
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handleSucceededPaymentIntent(
            event.data.object as Stripe.PaymentIntent,
          );
          break;
        case 'payment_intent.payment_failed':
          await this.handleFailedPaymentIntent(
            event.data.object as Stripe.PaymentIntent,
          );
          break;
        // Add more event types as needed
        default:
          this.logger.log(`Unhandled event type ${event.type}`);
      }

      return { received: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Webhook signature verification failed: ${message}`);
      throw new UnauthorizedException(`Webhook Error: ${message}`);
    }
  }

  private async handleSucceededPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
    try {
      // Check if payment already exists (idempotency)
      const existingPayment = await this.paymentsService.getOneByStripeIntentId(
        paymentIntent.id,
      );
      if (existingPayment) {
        this.logger.log(
          `Payment already exists for stripePaymentIntentId: ${paymentIntent.id}`,
        );
        return;
      }

      // Extract metadata
      const metadata = paymentIntent.metadata || {};
      const organizationId = metadata.organizationId;
      const userId = metadata.userId;
      const memberId = metadata.memberId || undefined;
      const membershipId = metadata.membershipId || undefined;

      // Validate required metadata
      if (!organizationId || !userId) {
        this.logger.error(
          `Missing required metadata in payment intent ${paymentIntent.id}`,
        );
        return;
      }

      // Create payment record
      await this.paymentsService.createStripePayment(
        organizationId,
        paymentIntent.amount,
        paymentIntent.currency.toUpperCase(),
        memberId,
        membershipId,
        paymentIntent.id,
        userId,
        'COMPLETED',
      );

      this.logger.log(
        `PaymentIntent ${paymentIntent.id} succeeded and payment record created`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to handle succeeded payment intent ${paymentIntent.id}: ${message}`,
      );
      // Still return success to Stripe to prevent retries
    }
  }

  private async handleFailedPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
    try {
      // Check if payment already exists (idempotency)
      const existingPayment = await this.paymentsService.getOneByStripeIntentId(
        paymentIntent.id,
      );
      if (existingPayment) {
        this.logger.log(
          `Payment already exists for stripePaymentIntentId: ${paymentIntent.id}`,
        );
        return;
      }

      // Extract metadata
      const metadata = paymentIntent.metadata || {};
      const organizationId = metadata.organizationId;
      const userId = metadata.userId;
      const memberId = metadata.memberId || undefined;
      const membershipId = metadata.membershipId || undefined;

      // Validate required metadata
      if (!organizationId || !userId) {
        this.logger.error(
          `Missing required metadata in payment intent ${paymentIntent.id}`,
        );
        return;
      }

      // Create payment record
      await this.paymentsService.createStripePayment(
        organizationId,
        paymentIntent.amount,
        paymentIntent.currency.toUpperCase(),
        memberId,
        membershipId,
        paymentIntent.id,
        userId,
        'FAILED',
      );

      this.logger.log(
        `PaymentIntent ${paymentIntent.id} failed and payment record created`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to handle failed payment intent ${paymentIntent.id}: ${message}`,
      );
      // Still return success to Stripe to prevent retries
    }
  }
}
