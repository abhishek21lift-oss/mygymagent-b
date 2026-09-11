import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CompleteEmbeddedSignupDto,
  SendWhatsAppMessageDto,
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
}
