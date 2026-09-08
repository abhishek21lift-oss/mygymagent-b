import { Controller, Get, Query } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { IntelligenceAnalyticsService } from './intelligence-analytics.service';

@Controller('analytics')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class IntelligenceAnalyticsController {
  constructor(private readonly analytics: IntelligenceAnalyticsService) {}

  @Get('risk-overview')
  @RequirePermissions('reports.view')
  async getRiskOverview(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.analytics.getRiskOverview(
      user.organizationId!,
      branchScope ?? undefined,
    );
  }

  @Get('risk-trend')
  @RequirePermissions('reports.view')
  async getRiskTrend(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days: string = '30',
  ) {
    const daysNum = parseInt(days, 10);
    return this.analytics.getRiskTrend(
      user.organizationId!,
      isNaN(daysNum) ? 30 : daysNum,
    );
  }

  @Get('revenue-at-risk')
  @RequirePermissions('reports.view')
  async getRevenueAtRisk(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.analytics.getRevenueAtRisk(
      user.organizationId!,
      branchScope ?? undefined,
    );
  }

  @Get('risk-by-branch')
  @RequirePermissions('reports.view')
  async getBranchRiskSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.getBranchRiskSummary(user.organizationId!);
  }
}
