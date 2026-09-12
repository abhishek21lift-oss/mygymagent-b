import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CompleteEmbeddedSignupDto,
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
  completeSignup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteEmbeddedSignupDto,
  ) {
    return this.whatsapp.completeEmbeddedSignup(user.organizationId!, dto);
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
   * Meta webhook verification (hub challenge). @Public() -- Meta signs
   * nothing here, the shared verify token is the credential. Answered
   * with the RAW challenge string (not the `{ data, meta }` envelope):
   * Meta requires the body to equal hub.challenge exactly, so the
   * response is written directly via @Res().
   */
  @Get('webhook')
  @Public()
  verifyWebhook(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') verifyToken?: string,
    @Query('hub.challenge') challenge?: string,
    @Res() res?: Response,
  ) {
    const answer = this.whatsapp.verifyWebhook(mode, verifyToken, challenge);
    return res!.status(HttpStatus.OK).send(answer);
  }

  /**
   * Meta message/status delivery receiver. @Public() (Meta signs with the
   * app secret, not a user JWT) and always 200 once the payload parses --
   * even for unknown numbers -- so Meta stops retrying undeliverable
   * events, the same ack-even-if-unknown pattern as the Razorpay webhook.
   */
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  handleWebhook(@Body() body: unknown) {
    return this.whatsapp.handleWebhook(body);
  }
}
