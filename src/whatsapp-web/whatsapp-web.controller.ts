import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  ConnectWhatsappWebDto,
  UpdateWhatsappWebSettingsDto,
} from './dto/whatsapp-web.dto';
import { WhatsappWebService } from './whatsapp-web.service';

/** A gym's own WhatsApp number linked as a WhatsApp Web device. See
 * README.md in this folder for the risk and the safeguards. */
@Controller('whatsapp-web')
export class WhatsappWebController {
  constructor(private readonly service: WhatsappWebService) {}

  @Get()
  @RequirePermissions('whatsapp.read')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.service.status(user.organizationId!);
  }

  @Post('connect')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_web', action: 'connect' })
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConnectWhatsappWebDto,
  ) {
    return this.service.connect(user.organizationId!, user.id, dto);
  }

  @Post('disconnect')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_web', action: 'disconnect' })
  disconnect(@CurrentUser() user: AuthenticatedUser) {
    return this.service.disconnect(user.organizationId!);
  }

  @Patch('settings')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_web', action: 'update_settings' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateWhatsappWebSettingsDto,
  ) {
    return this.service.updateSettings(user.organizationId!, dto);
  }
}
