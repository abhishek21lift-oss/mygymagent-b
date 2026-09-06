import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ChurnEngineService } from './churn-engine.service';

@Controller('analytics')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class ChurnEngineController {
  constructor(private readonly churnEngine: ChurnEngineService) {}

  @Get('members/:memberId/churn-assessment')
  @RequirePermissions('reports.view')
  async getMemberChurnAssessment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.churnEngine.assessMemberChurn(user.organizationId!, memberId);
  }

  @Get('members/at-risk/assessments')
  @RequirePermissions('reports.view')
  async getAtRiskAssessments(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.churnEngine.getAtRiskMembersWithAssessment(
      user.organizationId!,
      branchScope ?? undefined,
    );
  }
}
