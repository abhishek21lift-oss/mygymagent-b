import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;

  constructor(private readonly config: ConfigService) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      this.logger.error('Stripe secret key not configured');
      throw new Error('STRIPE_SECRET_KEY is required');
    }
    this.stripe = new Stripe(secretKey, { apiVersion: '2022-11-15' as any });
  }

  /** Create a payment intent for a given amount (in cents) and currency */
  async createPaymentIntent(
    amount: number,
    currency: string = 'usd',
    metadata?: Record<string, string>,
    idempotencyKey?: string,
  ) {
    return this.stripe.paymentIntents.create(
      { amount, currency, metadata },
      { idempotencyKey },
    );
  }

  /** Retrieve a payment intent */
  async retrievePaymentIntent(id: string) {
    return this.stripe.paymentIntents.retrieve(id);
  }

  /** Verify webhook signature and return the event */
  async constructEvent(
    payload: Buffer,
    sigHeader: string,
    webhookSecret: string,
  ) {
    return this.stripe.webhooks.constructEvent(
      payload,
      sigHeader,
      webhookSecret,
    );
  }
}
