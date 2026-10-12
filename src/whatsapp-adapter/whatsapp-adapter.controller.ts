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
} from './whatsapp-adapter.service';
import { WhatsAppAdapterFeatureGuard } from './whatsapp-adapter.guard';

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
    const limitNum = limit ? Number(limit) : undefined;
    return this.service.listAutoReplies(
      user.organizationId!,
      limitNum,
      search,
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
