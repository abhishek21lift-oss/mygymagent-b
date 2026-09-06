import { Controller, Get, Post, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { RiskEngineService } from './risk-engine.service';
import {
  MemberIntelligenceResponseDto,
  BatchComputeResponseDto,
} from './dto/risk-profile.dto';

@Controller('members')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class RiskEngineController {
  constructor(private readonly riskEngine: RiskEngineService) {}

  @Get(':memberId/intelligence')
  @RequirePermissions('members.view')
  async getMemberIntelligence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<MemberIntelligenceResponseDto | null> {
    return this.riskEngine.getMemberIntelligence(
      user.organizationId!,
      memberId,
    );
  }

  @Post(':memberId/intelligence/compute')
  @RequirePermissions('members.view')
  async computeRiskProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.riskEngine.computeRiskProfile(user.organizationId!, memberId);
  }

  @Post('intelligence/batch-compute')
  @RequirePermissions('reports.view')
  async batchCompute(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ): Promise<BatchComputeResponseDto> {
    const result = await this.riskEngine.batchComputeRiskProfiles(
      user.organizationId!,
      branchScope ?? undefined,
    );
    return {
      ...result,
      organizationId: user.organizationId!,
      branchScope,
    };
  }
}
