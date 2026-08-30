import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { Logger } from '@nestjs/common';
import { PaymentsService } from '../billing/payments.service';

@Controller('payments/webhook')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  constructor(
    private readonly config: ConfigService,
    private readonly stripeService: StripeService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() body: any,
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

    try {
      const event = this.stripeService.constructEvent(
        Buffer.from(JSON.stringify(body)),
        signature,
        webhookSecret,
      );

      // Handle the event
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handleSucceededPaymentIntent(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.handleFailedPaymentIntent(event.data.object);
          break;
        // Add more event types as needed
        default:
          this.logger.log(`Unhandled event type ${event.type}`);
      }

      return { received: true };
    } catch (err) {
      this.logger.error(
        `Webhook signature verification failed: ${err.message}`,
      );
      throw new UnauthorizedException(`Webhook Error: ${err.message}`);
    }
  }

  private async handleSucceededPaymentIntent(paymentIntent: any) {
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
      this.logger.error(
        `Failed to handle succeeded payment intent ${paymentIntent.id}: ${error.message}`,
      );
      // Still return success to Stripe to prevent retries
    }
  }

  private async handleFailedPaymentIntent(paymentIntent: any) {
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
      this.logger.error(
        `Failed to handle failed payment intent ${paymentIntent.id}: ${error.message}`,
      );
      // Still return success to Stripe to prevent retries
    }
  }
}
