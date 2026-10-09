import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  ScheduleWhatsAppMessageDto,
  SendWhatsAppMessageDto,
  CreateBroadcastDto,
  TestSendWhatsAppDto,
} from './dto/whatsapp.dto';
import { BroadcastService } from './broadcast.service';
import { ScheduledMessageService } from './scheduled-message.service';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly scheduled: ScheduledMessageService,
    private readonly broadcasts: BroadcastService,
  ) {}

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

  @Post('scheduled')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_message', action: 'schedule' })
  scheduleMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ScheduleWhatsAppMessageDto,
  ) {
    return this.scheduled.schedule(user.organizationId!, user.id, dto);
  }

  @Get('scheduled')
  @RequirePermissions('whatsapp.read')
  listScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.scheduled.list(
      user.organizationId!,
      Number.isFinite(limit) ? limit : 50,
    );
  }

  @Delete('scheduled/:id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_message', action: 'cancel_scheduled' })
  cancelScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.scheduled.cancel(user.organizationId!, id);
  }

  @Post('broadcasts')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_broadcast', action: 'create' })
  createBroadcast(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBroadcastDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.broadcasts.create(
      user.organizationId!,
      user.id,
      dto,
      branchScope,
    );
  }

  @Get('broadcasts/:id')
  @RequirePermissions('whatsapp.read')
  broadcastProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.broadcasts.progress(user.organizationId!, id, branchScope);
  }

  @Get('broadcasts')
  @RequirePermissions('whatsapp.read')
  listBroadcasts(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.broadcasts.list(
      user.organizationId!,
      Number.isFinite(limit) ? limit : 50,
      branchScope,
    );
  }

  @Delete('broadcasts/:id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_broadcast', action: 'cancel' })
  cancelBroadcast(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.broadcasts.cancel(user.organizationId!, id, branchScope);
  }

  @Get('contacts')
  @RequirePermissions('whatsapp.read')
  listContacts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 100;
    return this.whatsapp.listContacts(
      user.organizationId!,
      Number.isFinite(limit) ? limit : 100,
    );
  }

  @Get('contacts/:jid/picture')
  @RequirePermissions('whatsapp.read')
  contactPicture(
    @CurrentUser() user: AuthenticatedUser,
    @Param('jid') jid: string,
  ) {
    return this.whatsapp.contactPicture(user.organizationId!, jid);
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
}
