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
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import type { PaymentMethod } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { InvoicesService } from '../invoices/invoices.service';
import { PrismaService } from '../prisma/prisma.service';
import { RazorpayService } from './razorpay.service';

interface RazorpayPaymentEntity {
  id: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  method?: string;
  email?: string;
  notes?: Record<string, string> | string[] | null;
}

/** The invoice a payment belongs to, as the server-created order says. */
interface ResolvedInvoice {
  id: string;
  organizationId: string;
  /** Paise the order was created for; null for an order created before
   * orders were recorded (only Invoice.providerOrderId knows it). */
  expectedAmount: number | null;
  currency: string;
}

/** Razorpay's event ids are short (`evt_` + 14 chars); anything far longer
 * is not one, and is not worth a primary-key row. */
const MAX_EVENT_ID_LENGTH = 128;

/**
 * Razorpay's webhook. It is @Public() (Razorpay signs deliveries with the
 * webhook secret, not a user JWT) and always answers 200 once the
 * signature checks out -- even when the payload references something
 * unknown -- so Razorpay stops retrying a delivery that would never
 * succeed on a later attempt.
 *
 * There was a POST order route beside it that did nothing but delegate to
 * InvoicesService.retryCollection(), which POST /invoices/:id/retry-collection
 * already exposes under the same permission. Two paths to one action is
 * two paths to keep correct; the invoice route is the one the app calls.
 */
@Controller('payments/online/razorpay')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class RazorpayController {
  private readonly logger = new Logger(RazorpayController.name);

  constructor(
    private readonly razorpay: RazorpayService,
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string,
    @Headers('x-razorpay-event-id') eventId?: string,
  ) {
    if (!this.razorpay.isWebhookConfigured()) {
      this.logger.error('Razorpay webhook secret not configured');
      throw new InternalServerErrorException('Webhook secret not configured');
    }
    if (!signature) {
      throw new BadRequestException('Missing x-razorpay-signature header');
    }
    // HMAC is over the raw bytes -- reconstructed JSON would differ in
    // whitespace/key order from what Razorpay signed. Falls back to the
    // parsed body only when the raw buffer is unavailable (same
    // approximation the Stripe webhook controller uses).
    const rawBody: Buffer | string | undefined =
      req.rawBody ?? (req.body ? JSON.stringify(req.body) : undefined);
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let event: { event?: string; payload?: unknown };
    try {
      const text = Buffer.isBuffer(rawBody)
        ? rawBody.toString('utf8')
        : (rawBody as string);
      event = JSON.parse(text);
    } catch {
      throw new BadRequestException('Malformed webhook payload');
    }

    // Razorpay redelivers an event it did not see acknowledged in time.
    // Claiming the id first makes the second delivery a no-op; without the
    // header there is nothing to key on, and the per-payment idempotency
    // in applyOnlineCapture is what holds.
    if (eventId && !(await this.claimEvent(eventId))) {
      this.logger.log(`Ignoring duplicate Razorpay event ${eventId}`);
      return { received: true };
    }

    try {
      switch (event.event) {
        case 'payment.captured':
          await this.handleCaptured(this.paymentEntity(event));
          break;
        case 'payment.failed':
          await this.handleFailed(this.paymentEntity(event));
          break;
        default:
          this.logger.log(`Ignoring Razorpay event ${event.event}`);
      }
    } catch (error) {
      // A poison delivery must not ride Razorpay's retry loop forever.
      this.logger.error(
        `Razorpay webhook handling failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { received: true };
  }

  private paymentEntity(event: {
    payload?: unknown;
  }): RazorpayPaymentEntity | null {
    const entity = (
      event.payload as {
        payment?: { entity?: RazorpayPaymentEntity };
      } | null
    )?.payment?.entity;
    return entity ?? null;
  }

  /** True when this delivery is the first with this event id. */
  private async claimEvent(eventId: string): Promise<boolean> {
    if (eventId.length > MAX_EVENT_ID_LENGTH) return true;
    try {
      await this.prisma.razorpayWebhookEvent.create({ data: { id: eventId } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The invoice is whatever the order says -- the order is created by the
   * server (InvoicesService.retryCollection) and Razorpay will not capture
   * against it for anyone else's merchant account. The payment's `notes`
   * are only a cross-check: Checkout lets the payer set them, so a note
   * naming a different invoice than the order is refused, never followed.
   */
  private async resolveInvoice(
    entity: RazorpayPaymentEntity,
  ): Promise<ResolvedInvoice | null> {
    if (!entity.order_id) {
      this.logger.warn(
        `Ignoring Razorpay payment ${entity.id}: no order id to resolve an invoice from`,
      );
      return null;
    }

    let resolved: ResolvedInvoice | null = null;
    const order = await this.prisma.razorpayOrder.findUnique({
      where: { id: entity.order_id },
      select: {
        amount: true,
        currency: true,
        invoice: { select: { id: true, organizationId: true } },
      },
    });
    if (order) {
      resolved = {
        id: order.invoice.id,
        organizationId: order.invoice.organizationId,
        expectedAmount: order.amount,
        currency: order.currency.toUpperCase(),
      };
    } else {
      // An order created before razorpay_orders existed.
      const legacy = await this.prisma.invoice.findFirst({
        where: { providerOrderId: entity.order_id },
        select: { id: true, organizationId: true, currency: true },
      });
      if (legacy) {
        resolved = {
          id: legacy.id,
          organizationId: legacy.organizationId,
          expectedAmount: null,
          currency: legacy.currency.toUpperCase(),
        };
      }
    }
    if (!resolved) {
      this.logger.warn(
        `Ignoring Razorpay payment ${entity.id}: no invoice for order ${entity.order_id}`,
      );
      return null;
    }

    const notes =
      entity.notes && !Array.isArray(entity.notes) ? entity.notes : {};
    if (
      (notes.invoiceId && notes.invoiceId !== resolved.id) ||
      (notes.organizationId && notes.organizationId !== resolved.organizationId)
    ) {
      this.logger.warn(
        `Refusing Razorpay payment ${entity.id}: notes name invoice ${notes.invoiceId ?? '-'} (org ${notes.organizationId ?? '-'}) but order ${entity.order_id} belongs to invoice ${resolved.id}`,
      );
      return null;
    }
    return resolved;
  }

  /** The captured amount must be what the order asked for, in its
   * currency. A legacy order's amount is unknown, so the bound there is
   * the invoice's outstanding balance. */
  private async amountMatches(
    amount: number,
    currency: string | undefined,
    invoice: ResolvedInvoice,
  ): Promise<boolean> {
    if ((currency ?? invoice.currency).toUpperCase() !== invoice.currency) {
      return false;
    }
    if (!Number.isInteger(amount) || amount <= 0) return false;
    if (invoice.expectedAmount !== null) {
      return amount === invoice.expectedAmount;
    }
    const current = await this.invoices.getOne(
      invoice.organizationId,
      invoice.id,
    );
    const outstandingPaise = new Prisma.Decimal(current.outstanding)
      .mul(100)
      .round()
      .toNumber();
    return amount <= outstandingPaise;
  }

  private async handleCaptured(
    entity: RazorpayPaymentEntity | null,
  ): Promise<void> {
    if (!entity?.id || typeof entity.amount !== 'number') {
      this.logger.warn('Ignoring payment.captured without id/amount');
      return;
    }
    const invoice = await this.resolveInvoice(entity);
    if (!invoice) return;
    if (!(await this.amountMatches(entity.amount, entity.currency, invoice))) {
      this.logger.warn(
        `Refusing Razorpay payment ${entity.id}: captured ${entity.amount} ${entity.currency ?? '?'} but order ${entity.order_id} expects ${invoice.expectedAmount ?? 'at most the outstanding balance'} ${invoice.currency}`,
      );
      return;
    }
    await this.invoices.applyOnlineCapture(invoice.organizationId, invoice.id, {
      providerPaymentId: entity.id,
      amountRupees: new Prisma.Decimal(entity.amount).div(100),
      currency: (entity.currency ?? 'INR').toUpperCase(),
      method: this.mapMethod(entity.method),
    });
    this.logger.log(
      `Razorpay payment ${entity.id} captured against invoice ${invoice.id}`,
    );
  }

  private async handleFailed(
    entity: RazorpayPaymentEntity | null,
  ): Promise<void> {
    if (!entity?.id) {
      this.logger.warn('Ignoring payment.failed without id');
      return;
    }
    const invoice = await this.resolveInvoice(entity);
    if (!invoice) return;
    // Stale failure for a payment that already captured (out-of-order
    // delivery) -- the money is recorded; nothing to dun about.
    const captured = await this.prisma.payment.findUnique({
      where: { providerPaymentId: entity.id },
      select: { id: true },
    });
    if (captured) return;
    const current = await this.prisma.invoice.findFirst({
      where: { id: invoice.id },
      select: { status: true },
    });
    if (current?.status === 'PAID') return;
    // Razorpay retries identical deliveries minutes apart -- a row for this
    // invoice from the last hour is the same failure, not a new one.
    const recent = await this.prisma.dunningAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        templateKey: 'payment.failed',
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (recent) return;
    await this.prisma.dunningAttempt.create({
      data: {
        invoiceId: invoice.id,
        channel: 'EMAIL',
        templateKey: 'payment.failed',
        status: 'FAILED',
      },
    });
    this.logger.log(
      `Recorded failed collection for invoice ${invoice.id} (provider payment ${entity.id})`,
    );
  }

  private mapMethod(method: string | undefined): PaymentMethod {
    switch ((method ?? '').toLowerCase()) {
      case 'upi':
        return 'UPI';
      case 'card':
        return 'CARD';
      case 'netbanking':
        return 'BANK_TRANSFER';
      default:
        return 'OTHER';
    }
  }
}
