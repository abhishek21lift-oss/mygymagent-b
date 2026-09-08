import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { StripeService } from './stripe.service';
import { CreateOnlinePaymentIntentDto } from './dto/create-online-payment-intent.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Staff-initiated online payment: creates a Stripe PaymentIntent for a
 * member's membership. The amount is derived server-side from the
 * membership's outstanding balance -- the client supplies only WHAT to
 * charge for, never HOW MUCH (the old dto.amount field trusted the
 * caller, letting any payments.create holder charge arbitrary sums).
 */
@Controller('payments/online')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class OnlinePaymentController {
  private readonly logger = new Logger(OnlinePaymentController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  @Post('intent')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.create')
  async createPaymentIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') idempotencyKey: string,
    @Body() dto: CreateOnlinePaymentIntentDto,
  ) {
    if (!user.organizationId) {
      throw new UnauthorizedException(
        'User must belong to an organization to create payment intents',
      );
    }
    const organizationId = user.organizationId;

    // Both ids are org-ownership-checked: an intent can only ever
    // reference this tenant's member/membership.
    const membership = await this.prisma.membership.findFirst({
      where: { id: dto.membershipId, organizationId },
      include: { membershipPlan: true },
    });
    if (!membership) {
      throw new NotFoundException('Membership not found');
    }
    const member = await this.prisma.member.findFirst({
      where: { id: membership.memberId, organizationId, deletedAt: null },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Derive the amount: what is still owed on this membership. Paid =
    // completed/partially-refunded payments linked to this membership
    // minus refunds on those payments.
    const payments = await this.prisma.payment.findMany({
      where: {
        organizationId,
        membershipId: membership.id,
        status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] },
      },
      select: { id: true, amount: true },
    });
    const refunds = payments.length
      ? await this.prisma.refund.findMany({
          where: {
            organizationId,
            paymentId: { in: payments.map((p) => p.id) },
          },
          select: { amount: true },
        })
      : [];
    const paid = payments.reduce(
      (sum, p) => sum.plus(p.amount),
      new Decimal(0),
    );
    const refunded = refunds.reduce(
      (sum, r) => sum.plus(r.amount),
      new Decimal(0),
    );
    const outstanding = membership.price.minus(paid).plus(refunded);
    if (outstanding.lte(0)) {
      throw new BadRequestException(
        'This membership has no outstanding balance to charge',
      );
    }

    // Stripe expects integer cents.
    const amountCents = Number(outstanding.toFixed(2)) * 100;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException(
        'Outstanding balance does not convert to a valid charge amount',
      );
    }

    const metadata: Record<string, string> = {
      organizationId,
      userId: user.id,
      memberId: member.id,
      membershipId: membership.id,
    };
    if (dto.description) {
      metadata.description = dto.description;
    }

    try {
      const paymentIntent = await this.stripeService.createPaymentIntent(
        amountCents,
        membership.currency.toLowerCase(),
        metadata,
        idempotencyKey,
      );

      return {
        clientSecret: paymentIntent.client_secret,
        id: paymentIntent.id,
        amount: amountCents,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create payment intent: ${(error as Error).message}`,
      );
      throw new InternalServerErrorException('Failed to create payment intent');
    }
  }
}
