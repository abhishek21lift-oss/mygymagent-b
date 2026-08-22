import { Controller, Get, Query } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { GetRevenueSummaryQueryDto } from './dto/get-revenue-summary-query.dto';
import { FinanceService } from './finance.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly finance: FinanceService) {}

  @Get('revenue')
  @RequirePermissions('reports.view')
  getRevenueSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetRevenueSummaryQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.finance.getRevenueSummary(
      user.organizationId!,
      query,
      branchScope,
    );
  }
}
