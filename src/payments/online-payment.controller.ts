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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import { StripeService } from './stripe.service';
import { Logger } from '@nestjs/common';
import { CreateOnlinePaymentIntentDto } from './dto/create-online-payment-intent.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

@Controller('payments/online')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class OnlinePaymentController {
  private readonly logger = new Logger(OnlinePaymentController.name);
  constructor(
    private readonly config: ConfigService,
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
    // Ensure the user belongs to an organization
    if (!user.organizationId) {
      throw new UnauthorizedException(
        'User must belong to an organization to create payment intents',
      );
    }

    // Validate that either memberId or membershipId is provided (or both)
    if (!dto.memberId && !dto.membershipId) {
      throw new BadRequestException(
        'Either memberId or membershipId must be provided',
      );
    }

    // Prepare metadata to pass to Stripe (non-sensitive identifiers)
    const metadata: Record<string, string> = {
      organizationId: user.organizationId,
      userId: user.id,
    };

    if (dto.memberId) {
      metadata.memberId = dto.memberId;
    }
    if (dto.membershipId) {
      metadata.membershipId = dto.membershipId;
    }
    if (dto.description) {
      metadata.description = dto.description;
    }

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
      this.logger.error(`Failed to create payment intent: ${error.message}`);
      throw new InternalServerErrorException('Failed to create payment intent');
    }
  }
}
