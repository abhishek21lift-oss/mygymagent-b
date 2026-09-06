import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { WhatsAppService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get('integration')
  @RequirePermissions('settings.manage')
  getIntegration(@CurrentUser() user: AuthenticatedUser) { return this.whatsapp.getIntegration(user.organizationId!); }

  @Post('integration/embedded-signup')
  @RequirePermissions('settings.manage')
  @Audited({ resource: 'whatsapp-integration', action: 'embedded-signup' })
  completeEmbeddedSignup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { code: string; wabaId: string; phoneNumberId?: string },
  ) { return this.whatsapp.completeEmbeddedSignup(user.organizationId!, body); }

  /** Legacy/manual connection endpoint retained for controlled migrations/tests. */
  @Post('integration/connect')
  @RequirePermissions('settings.manage')
  @Audited({ resource: 'whatsapp-integration', action: 'connect' })
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { phoneNumberId: string; wabaId?: string; businessAccountId?: string; accessToken: string; displayPhoneNumber?: string; displayName?: string },
  ) { return this.whatsapp.connect(user.organizationId!, body); }

  @Post('integration/disconnect')
  @RequirePermissions('settings.manage')
  @Audited({ resource: 'whatsapp-integration', action: 'disconnect' })
  disconnect(@CurrentUser() user: AuthenticatedUser) { return this.whatsapp.disconnect(user.organizationId!); }

  @Post('messages')
  @RequirePermissions('members.update')
  send(@CurrentUser() user: AuthenticatedUser, @Body() body: { to: string; text: string }) { return this.whatsapp.sendText(user.organizationId!, body.to, body.text); }

  @Get('messages')
  @RequirePermissions('members.read')
  messages(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) { return this.whatsapp.listMessages(user.organizationId!, Number(limit)); }

  @Get('webhook')
  @Public()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() response: Response,
  ) {
    const verifiedChallenge = this.whatsapp.webhookVerify(mode, token, challenge);
    return response.status(200).type('text/plain').send(verifiedChallenge);
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  receive(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() payload: unknown,
  ) {
    if (!this.whatsapp.verifyWebhookSignature(signature, request.rawBody)) throw new UnauthorizedException('Invalid WhatsApp webhook signature');
    return this.whatsapp.handleWebhook(payload as Parameters<WhatsAppService['handleWebhook']>[0]);
  }
}
