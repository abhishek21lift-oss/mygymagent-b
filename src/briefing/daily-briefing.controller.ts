import { Controller, Get } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { DailyBriefingService } from './daily-briefing.service';

/// Same `reports.view` tier as src/analytics/ -- this is an aggregation
/// of data already visible under that permission, not a new access
/// grant.
@Controller('briefing')
export class DailyBriefingController {
  constructor(private readonly dailyBriefing: DailyBriefingService) {}

  @Get('daily')
  @RequirePermissions('reports.view')
  getDaily(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.dailyBriefing.getDailyBriefing(
      user.organizationId!,
      branchScope,
    );
  }
}
