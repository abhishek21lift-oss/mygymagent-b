import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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

  @Post('integration/connect')
  @RequirePermissions('settings.manage')
  @Audited({ resource: 'whatsapp-integration', action: 'connect' })
  connect(@CurrentUser() user: AuthenticatedUser, @Body() body: { phoneNumberId: string; businessAccountId?: string; accessToken: string; displayPhoneNumber?: string; displayName?: string }) { return this.whatsapp.connect(user.organizationId!, body); }

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
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) { return this.whatsapp.webhookVerify(mode, token, challenge); }

  @Post('webhook')
  @Public()
  receive(@Body() payload: unknown) { return this.whatsapp.handleWebhook(payload); }
}
