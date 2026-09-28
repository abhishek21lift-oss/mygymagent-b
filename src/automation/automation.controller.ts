import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AutomationOverviewService } from './automation-overview.service';

/**
 * What the automation queue is doing for this gym.
 *
 * Read-only on purpose. Every job scans all organizations at once, so a
 * "run now" here would send reminders on behalf of every other gym too.
 */
@Controller('automation')
export class AutomationController {
  constructor(private readonly overview: AutomationOverviewService) {}

  @Get()
  @RequirePermissions('reports.view')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.overview.overview(user.organizationId!);
  }
}
