import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import {
  CreateAutoReplyDto,
  UpdateAutoReplyDto,
  UpdateBotConfigDto,
} from './whatsapp-adapter.service';
import { WhatsAppAdapterFeatureGuard } from './whatsapp-adapter.guard';

/** Query `limit` parsing shared by the list endpoints: mirrors the codebase
 * convention (`Number.isFinite(x) ? x : default`) used by the legacy
 * WhatsApp contacts endpoint. Non-numeric input (e.g. `?limit=abc`)
 * falls back to the service default instead of reaching Prisma as NaN. */
function toLimit(limit?: string): number | undefined {
  if (limit === undefined || limit === '') return undefined;
  const parsed = Number(limit);
  return Number.isFinite(parsed) ? parsed : undefined;
}

@UseGuards(WhatsAppAdapterFeatureGuard)
@Controller('whatsapp-adapter')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class WhatsAppAdapterController {
  constructor(private readonly service: WhatsAppAdapterService) {}

  @Get('status')
  @RequirePermissions('whatsapp.read')
  async getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getStatus(user.organizationId!);
  }

  @Get('auto-replies')
  @RequirePermissions('whatsapp.read')
  async listAutoReplies(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listAutoReplies(
      user.organizationId!,
      toLimit(limit),
      search,
    );
  }

  @Get('contacts')
  @RequirePermissions('whatsapp.read')
  async listContacts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listContacts(
      user.organizationId!,
      toLimit(limit),
      search,
    );
  }

  @Get('groups')
  @RequirePermissions('whatsapp.read')
  async listGroups(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.service.listGroups(user.organizationId!, toLimit(limit));
  }

  @Get('bot/config')
  @RequirePermissions('whatsapp.read')
  async getBotConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getBotConfig(user.organizationId!);
  }

  @Patch('bot/config')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_bot_config', action: 'update' })
  async updateBotConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBotConfigDto,
  ) {
    return this.service.updateBotConfig(user.organizationId!, dto);
  }

  @Get('automation/activity')
  @RequirePermissions('whatsapp.read')
  async automationActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.service.automationActivity(
      user.organizationId!,
      toLimit(limit),
    );
  }

  @Post('auto-replies')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_auto_reply', action: 'create' })
  async createAutoReply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAutoReplyDto,
  ) {
    return this.service.createAutoReply(user.organizationId!, dto, user.id);
  }

  @Patch('auto-replies/:id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_auto_reply', action: 'update' })
  async updateAutoReply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAutoReplyDto,
  ) {
    return this.service.updateAutoReply(user.organizationId!, id, dto);
  }

  @Delete('auto-replies/:id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_auto_reply', action: 'delete' })
  async deleteAutoReply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.deleteAutoReply(user.organizationId!, id);
  }
}
