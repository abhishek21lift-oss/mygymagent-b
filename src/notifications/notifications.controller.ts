/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') rawLimit?: string,
    @Query('type') type?: string,
    @Query('category') category?: string,
    @Query('priority') priority?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    if (unreadOnly && !['true', 'false'].includes(unreadOnly)) throw new BadRequestException('unreadOnly must be true or false');
    if (includeArchived && !['true', 'false'].includes(includeArchived)) throw new BadRequestException('includeArchived must be true or false');
    const parsedLimit = Number.parseInt(rawLimit ?? '50', 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    return this.notifications.list(
      user.id,
      user.organizationId!,
      unreadOnly === 'true',
      limit,
      type,
      search,
      cursor,
      category,
      priority,
      includeArchived === 'true',
    );
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, user.organizationId!, id);
  }

  @Patch(':id/unread')
  markUnread(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markUnread(user.id, user.organizationId!, id);
  }

  @Patch(':id/archive')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.archive(user.id, user.organizationId!, id);
  }

  @Patch(':id/unarchive')
  unarchive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.unarchive(user.id, user.organizationId!, id);
  }

  @Patch(':id/snooze')
  snooze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: { until?: string }) {
    const until = new Date(body.until ?? '');
    if (!Number.isFinite(until.getTime())) throw new BadRequestException('until must be a valid ISO date');
    return this.notifications.snooze(user.id, user.organizationId!, id, until);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.delete(user.id, user.organizationId!, id);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id, user.organizationId!);
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.id, user.organizationId!);
  }

  @Patch('preferences/:category')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Param('category') category: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(user.id, user.organizationId!, category, dto);
  }
}
