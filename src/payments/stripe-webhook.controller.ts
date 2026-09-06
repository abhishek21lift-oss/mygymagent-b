import {
  Controller,
  Post,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';
import { StripeService } from './stripe.service';
import { PaymentsService } from '../billing/payments.service';

/** Stripe uses the currency's smallest unit for PaymentIntent amounts. */
function fromStripeMinorUnit(amount: number, currency: string): number {
  const normalized = currency.toLowerCase();
  const zeroDecimalCurrencies = new Set([
    'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
    'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
  ]);
  const threeDecimalCurrencies = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
  const divisor = zeroDecimalCurrencies.has(normalized)
    ? 1
    : threeDecimalCurrencies.has(normalized)
      ? 1000
      : 100;
  return amount / divisor;
}

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
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      this.logger.error('Stripe webhook secret not configured');
      throw new InternalServerErrorException('Webhook secret not configured');
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    const payload = request.rawBody;
    if (!payload) {
      this.logger.error('Stripe webhook raw body is unavailable');
      throw new InternalServerErrorException('Webhook raw body unavailable');
    }

    let event: Stripe.Event;
    try {
      event = await this.stripeService.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid signature';
      this.logger.warn(`Stripe webhook signature verification failed: ${message}`);
      throw new UnauthorizedException('Invalid Stripe webhook signature');
    }

    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook processing failed';
      this.logger.error(`Stripe webhook processing failed: ${message}`);
      throw new InternalServerErrorException('Webhook processing failed');
    }
  }

  private async handleSucceededPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
    const existingPayment = await this.paymentsService.getOneByStripeIntentId(
      paymentIntent.id,
    );
    if (existingPayment) return;

    const metadata = paymentIntent.metadata || {};
    const organizationId = metadata.organizationId;
    const userId = metadata.userId;
    const memberId = metadata.memberId || undefined;
    const membershipId = metadata.membershipId || undefined;
    if (!organizationId || !userId) {
      throw new BadRequestException('Stripe payment intent is missing required metadata');
    }

    const currency = String(paymentIntent.currency).toUpperCase();
    await this.paymentsService.createStripePayment(
      organizationId,
      fromStripeMinorUnit(paymentIntent.amount, currency),
      currency,
      memberId,
      membershipId,
      paymentIntent.id,
      userId,
      'COMPLETED',
    );
  }

  private async handleFailedPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
    const existingPayment = await this.paymentsService.getOneByStripeIntentId(
      paymentIntent.id,
    );
    if (existingPayment) return;

    const metadata = paymentIntent.metadata || {};
    const organizationId = metadata.organizationId;
    const userId = metadata.userId;
    const memberId = metadata.memberId || undefined;
    const membershipId = metadata.membershipId || undefined;
    if (!organizationId || !userId) {
      throw new BadRequestException('Stripe payment intent is missing required metadata');
    }

    const currency = String(paymentIntent.currency).toUpperCase();
    await this.paymentsService.createStripePayment(
      organizationId,
      fromStripeMinorUnit(paymentIntent.amount, currency),
      currency,
      memberId,
      membershipId,
      paymentIntent.id,
      userId,
      'FAILED',
    );
  }
}
