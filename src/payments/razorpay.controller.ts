import {
  BadRequestException,
  Body,
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
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { InvoicesService } from '../invoices/invoices.service';
import { CreateRazorpayOrderDto } from '../invoices/dto/create-razorpay-order.dto';
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

/**
 * Razorpay online collection against invoices. The order endpoint is a
 * thin delegate to InvoicesService.retryCollection(); the webhook is
 * @Public() (Razorpay signs deliveries with the webhook secret, not a
 * user JWT) and always answers 200 once the signature checks out -- even
 * when the payload references something unknown -- so Razorpay stops
 * retrying a delivery that would never succeed on a later attempt.
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

  @Post('order')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.create')
  createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRazorpayOrderDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoices.retryCollection(
      user.organizationId!,
      dto.invoiceId,
      branchScope,
    );
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string,
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

  private async resolveInvoice(entity: RazorpayPaymentEntity) {
    const notes =
      entity.notes && !Array.isArray(entity.notes) ? entity.notes : {};
    const organizationId = notes.organizationId;
    const noteInvoiceId = notes.invoiceId;
    if (organizationId && noteInvoiceId) {
      const byNote = await this.prisma.invoice.findFirst({
        where: { id: noteInvoiceId, organizationId },
        select: { id: true, organizationId: true },
      });
      if (byNote) return byNote;
    }
    if (entity.order_id) {
      const byOrder = await this.prisma.invoice.findFirst({
        where: { providerOrderId: entity.order_id },
        select: { id: true, organizationId: true },
      });
      if (byOrder) return byOrder;
    }
    return null;
  }

  private async handleCaptured(
    entity: RazorpayPaymentEntity | null,
  ): Promise<void> {
    if (!entity?.id || typeof entity.amount !== 'number') {
      this.logger.warn('Ignoring payment.captured without id/amount');
      return;
    }
    const invoice = await this.resolveInvoice(entity);
    if (!invoice) {
      this.logger.warn(
        `Ignoring payment.captured ${entity.id}: no invoice for order ${entity.order_id ?? 'unknown'}`,
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
    if (!invoice) {
      this.logger.warn(
        `Ignoring payment.failed ${entity.id}: no invoice for order ${entity.order_id ?? 'unknown'}`,
      );
      return;
    }
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
