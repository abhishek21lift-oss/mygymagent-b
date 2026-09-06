import {
  Body,
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Headers,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import { StripeService } from './stripe.service';
import { Logger } from '@nestjs/common';
import { CreateOnlinePaymentIntentDto } from './dto/create-online-payment-intent.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';

@Controller('payments/online')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class OnlinePaymentController {
  private readonly logger = new Logger(OnlinePaymentController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
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

    if (!Number.isSafeInteger(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in the currency minor unit');
    }

    if (!dto.memberId && !dto.membershipId) {
      throw new BadRequestException(
        'Either memberId or membershipId must be provided',
      );
    }

    const [member, membership] = await Promise.all([
      dto.memberId
        ? this.prisma.member.findFirst({
            where: {
              id: dto.memberId,
              organizationId: user.organizationId,
              deletedAt: null,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.membershipId
        ? this.prisma.membership.findFirst({
            where: {
              id: dto.membershipId,
              organizationId: user.organizationId,
            },
            select: { id: true, memberId: true },
          })
        : Promise.resolve(null),
    ]);

    if (dto.memberId && !member) {
      throw new NotFoundException('Member not found');
    }
    if (dto.membershipId && !membership) {
      throw new NotFoundException('Membership not found');
    }
    if (member && membership && member.id !== membership.memberId) {
      throw new BadRequestException(
        'Membership does not belong to the specified member',
      );
    }

    const metadata: Record<string, string> = {
      organizationId: user.organizationId,
      userId: user.id,
    };

    const resolvedMemberId = member?.id ?? membership?.memberId;
    if (resolvedMemberId) metadata.memberId = resolvedMemberId;
    if (membership?.id) metadata.membershipId = membership.id;
    if (dto.description) metadata.description = dto.description;

    try {
      const paymentIntent = await this.stripeService.createPaymentIntent(
        dto.amount,
        dto.currency ?? 'usd',
        metadata,
        idempotencyKey,
      );

      return {
        clientSecret: paymentIntent.client_secret,
        id: paymentIntent.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to create payment intent: ${message}`);
      throw new InternalServerErrorException('Failed to create payment intent');
    }
  }
}
