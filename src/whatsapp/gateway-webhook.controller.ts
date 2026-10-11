import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { GatewayWebhookService } from './gateway-webhook.service';

/**
 * WA-AKG's outbound webhooks. `@Public()` (the gateway signs deliveries
 * with `WA_GATEWAY_WEBHOOK_SECRET`, not a user JWT -- same pattern as the
 * Razorpay controller) and always answers 200 once the signature checks
 * out, even for unknown events, so the gateway stops retrying a delivery
 * that would never succeed on a later attempt.
 */
@Controller('whatsapp')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class GatewayWebhookController {
  constructor(private readonly gatewayWebhook: GatewayWebhookService) {}

  @Post('gateway-inbound')
  @Public()
  @HttpCode(HttpStatus.OK)
  handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string | undefined,
  ) {
    // main.ts preserves the untouched bytes via the json() verify callback;
    // re-serializing the parsed body would change whitespace/key order and
    // break the HMAC. Falls back to the parsed body only when the buffer is
    // unavailable (same approximation the payment webhooks use).
    const raw: Buffer =
      req.rawBody ??
      Buffer.from(
        JSON.stringify((req as Request & { body?: unknown }).body ?? {}),
      );
    return this.gatewayWebhook.handle(raw, signature);
  }
}
