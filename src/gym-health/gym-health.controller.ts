import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  BranchFilterQueryDto,
  effectiveBranch,
} from '../common/branch/branch-filter';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { GymHealthService } from './gym-health.service';
import { CooBriefingService } from './coo-briefing.service';
import { CooTrendsService } from './coo-trends.service';

@Controller('analytics')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class GymHealthController {
  constructor(
    private readonly gymHealth: GymHealthService,
    private readonly briefing: CooBriefingService,
    private readonly trends: CooTrendsService,
  ) {}

  @Get('gym-health')
  @RequirePermissions('reports.view')
  getHealth(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.gymHealth.getHealth(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('coo-briefing')
  @RequirePermissions('reports.view')
  getBriefing(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.briefing.getBriefing(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('coo-trends')
  @RequirePermissions('reports.view')
  getTrends(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.trends.getTrends(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('coo-forecast')
  @RequirePermissions('reports.view')
  getForecast(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.trends.getForecast(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }
}
