import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { Public } from '../common/decorators/public.decorator';
import { StripeService } from './stripe.service';
import { PaymentsService } from '../billing/payments.service';

/**
 * Stripe -> us webhook. @Public: Stripe cannot present a JWT; the
 * request is authenticated by the stripe-signature HMAC over the exact
 * raw bytes (verified below), the same trust model as the WhatsApp
 * webhook controller.
 */
@Controller('payments/webhook')
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
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string,
  ) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      this.logger.error('Stripe webhook secret not configured');
      throw new InternalServerErrorException('Webhook secret not configured');
    }

    // Stripe signs the exact raw bytes of the POST body; a parsed-then-
    // re-serialized body (key order, whitespace) would never verify.
    if (!request.rawBody || !request.rawBody.length) {
      throw new BadRequestException('Missing request body');
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    let event;
    try {
      event = await this.stripeService.constructEvent(
        request.rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      this.logger.warn(
        `Webhook signature verification failed: ${(err as Error).message}`,
      );
      // No internals in the response body -- the signature is the auth.
      throw new UnauthorizedException('Webhook signature verification failed');
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handleSucceededPaymentIntent(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await this.handleFailedPaymentIntent(event.data.object);
        break;
      default:
        this.logger.log(`Unhandled event type ${event.type}`);
    }

    return { received: true };
  }

  /** Extracts the shared metadata + resolves the recordable member/
   * membership ids. Returns null when the intent doesn't carry enough
   * metadata to record anything (logged, not an error -- Stripe will
   * not retry). */
  private extractMetadata(paymentIntent: {
    id: string;
    metadata?: Record<string, string>;
  }): {
    organizationId: string;
    userId: string;
    memberId?: string;
    membershipId?: string;
  } | null {
    const metadata = paymentIntent.metadata || {};
    const { organizationId, userId } = metadata;
    if (!organizationId || !userId) {
      this.logger.warn(
        `Missing required metadata in payment intent ${paymentIntent.id}`,
      );
      return null;
    }
    return {
      organizationId,
      userId,
      memberId: metadata.memberId || undefined,
      membershipId: metadata.membershipId || undefined,
    };
  }

  private async handleSucceededPaymentIntent(
    paymentIntent: Stripe.PaymentIntent,
  ) {
    const meta = this.extractMetadata(paymentIntent);
    if (!meta) return;

    // Idempotency pre-check: Stripe redelivers events. Advisory only --
    // the unique index on stripePaymentIntentId is the real guard against
    // concurrent redelivery racing this check.
    const existing = await this.paymentsService.getOneByStripeIntentId(
      paymentIntent.id,
    );
    if (existing) {
      this.logger.log(
        `Payment already exists for stripePaymentIntentId: ${paymentIntent.id}`,
      );
      return;
    }

    // Stripe amounts are integer cents; Payment.amount is
    // Decimal(10,2) in major units (the same column manual payments
    // treat as dollars) -- convert, or every online charge records 100x.
    const amountMajorUnits = paymentIntent.amount / 100;

    await this.paymentsService.createStripePayment(
      meta.organizationId,
      amountMajorUnits,
      paymentIntent.currency.toUpperCase(),
      meta.memberId,
      meta.membershipId,
      paymentIntent.id,
      meta.userId,
      'COMPLETED',
    );
    this.logger.log(
      `PaymentIntent ${paymentIntent.id} succeeded and payment record created`,
    );
  }

  private async handleFailedPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
    const meta = this.extractMetadata(paymentIntent);
    if (!meta) return;

    const existing = await this.paymentsService.getOneByStripeIntentId(
      paymentIntent.id,
    );
    if (existing) {
      this.logger.log(
        `Payment already exists for stripePaymentIntentId: ${paymentIntent.id}`,
      );
      return;
    }

    const amountMajorUnits = paymentIntent.amount / 100;

    await this.paymentsService.createStripePayment(
      meta.organizationId,
      amountMajorUnits,
      paymentIntent.currency.toUpperCase(),
      meta.memberId,
      meta.membershipId,
      paymentIntent.id,
      meta.userId,
      'FAILED',
    );
    this.logger.log(
      `PaymentIntent ${paymentIntent.id} failed and payment record created`,
    );
  }
}
