import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermissions('notifications.manage')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') rawLimit?: string,
  ) {
    return this.notifications.list(
      user.id,
      user.organizationId!,
      unreadOnly === 'true',
      Number.parseInt(rawLimit ?? '50', 10) || 50,
    );
  }

  @Patch(':id/read')
  @RequirePermissions('notifications.manage')
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.notifications.markRead(user.id, user.organizationId!, id);
  }

  @Patch('read-all')
  @RequirePermissions('notifications.manage')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id, user.organizationId!);
  }

  @Get('preferences')
  @RequirePermissions('notifications.manage')
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.id, user.organizationId!);
  }

  @Patch('preferences/:category')
  @RequirePermissions('notifications.manage')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Param('category') category: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(
      user.id,
      user.organizationId!,
      category,
      dto,
    );
  }
}
