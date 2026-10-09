import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AutomationOverviewService } from './automation-overview.service';
import { AutomationSettingsService } from './automation-settings.service';
import { UpdateAutomationSettingDto } from './dto/automation-settings.dto';

/**
 * What the automation queue is doing for this gym.
 *
 * Read-only on purpose. Every job scans all organizations at once, so a
 * "run now" here would send reminders on behalf of every other gym too.
 *
 * The settings routes below are the exception: per-gym ON/OFF switches
 * (the WhatsApp Automation Control Center), scoped by organizationId so
 * one gym's toggle never touches another's.
 */
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly overview: AutomationOverviewService,
    private readonly settings: AutomationSettingsService,
  ) {}

  @Get()
  @RequirePermissions('reports.view')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.overview.overview(user.organizationId!);
  }

  @Get('settings')
  @RequirePermissions('reports.view')
  listSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.list(user.organizationId!);
  }

  @Patch('settings/:key')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'automation_setting', action: 'update' })
  updateSetting(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() dto: UpdateAutomationSettingDto,
  ) {
    return this.settings.update(user.organizationId!, key, dto, user.id);
  }
}
