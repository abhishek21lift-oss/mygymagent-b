import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  SendWhatsAppMessageDto,
  TestSendWhatsAppDto,
} from './dto/whatsapp.dto';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get('integration')
  @RequirePermissions('whatsapp.read')
  getIntegration(@CurrentUser() user: AuthenticatedUser) {
    return this.whatsapp.getIntegration(user.organizationId!);
  }

  @Post('integration/embedded-signup')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_integration', action: 'connect' })
  completeSignup() {
    return this.whatsapp.completeEmbeddedSignup();
  }

  @Post('integration/disconnect')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_integration', action: 'disconnect' })
  disconnectLegacy(@CurrentUser() user: AuthenticatedUser) {
    return this.whatsapp.disconnect(user.organizationId!);
  }

  @Post('disconnect')
  @RequirePermissions('settings.manage')
  @Audited({ resource: 'whatsapp_integration', action: 'disconnect' })
  disconnect(@CurrentUser() user: AuthenticatedUser) {
    return this.whatsapp.disconnect(user.organizationId!);
  }

  @Get('messages')
  @RequirePermissions('whatsapp.read')
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.whatsapp.listMessages(
      user.organizationId!,
      Number.isFinite(limit) ? limit : 50,
    );
  }

  @Post('messages')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_message', action: 'send' })
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendWhatsAppMessageDto,
  ) {
    return this.whatsapp.sendMessage(user.organizationId!, dto);
  }

  @Post('test-send')
  @RequirePermissions('settings.manage')
  @Audited({ resource: 'whatsapp_message', action: 'test_send' })
  testSend(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TestSendWhatsAppDto,
  ) {
    return this.whatsapp.testSend(user.organizationId!, dto);
  }

  @Get('logs')
  @RequirePermissions('whatsapp.read')
  listLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.whatsapp.listLogs(
      user.organizationId!,
      Number.isFinite(limit) ? limit : 50,
    );
  }

  @Get('templates')
  @RequirePermissions('whatsapp.read')
  listTemplates(@CurrentUser() user: AuthenticatedUser) {
    return this.whatsapp.listTemplates(user.organizationId!);
  }

  @Get('inbound')
  @RequirePermissions('whatsapp.read')
  listInbound(
    @CurrentUser() user: AuthenticatedUser,
    @Query('matched') matchedRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    let matched: boolean | undefined;
    if (matchedRaw !== undefined) {
      if (matchedRaw !== 'true' && matchedRaw !== 'false') {
        throw new BadRequestException(
          'matched must be "true" or "false" when provided',
        );
      }
      matched = matchedRaw === 'true';
    }
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.whatsapp.listInbound(user.organizationId!, {
      matched,
      limit: Number.isFinite(limit) ? limit : 50,
    });
  }

  /**
   * WA-AKG event receiver. @Public() (WA-AKG signs with the shared
   * webhook secret, not a user JWT) and always 200 once the payload
   * parses -- even for unknown sessions -- so the gateway stops retrying
   * undeliverable events. The `X-Webhook-Signature` HMAC is verified
   * first: without it the session id in the body is attacker-controlled
   * routing, not proof of origin.
   */
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Body() body: unknown,
  ) {
    // Signature is over the raw bytes -- re-serializing the parsed body
    // would change whitespace/key order and break verification (same
    // pattern as the Stripe webhook controller).
    const rawBody: Buffer =
      req.rawBody ?? Buffer.from(JSON.stringify((body ?? {}) as unknown));
    this.whatsapp.verifyWaAkgSignature(rawBody, signature);
    return this.whatsapp.handleWebhook(body);
  }
}
