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

@Controller('analytics/gym-health')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class GymHealthController {
  constructor(private readonly gymHealth: GymHealthService) {}

  @Get()
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
}
