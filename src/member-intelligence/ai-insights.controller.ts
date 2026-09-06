import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  AiInsightsService,
  MemberInsight,
  SegmentInsight,
} from './ai-insights.service';

@Controller('members')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AiInsightsController {
  constructor(private readonly insights: AiInsightsService) {}

  @Get(':memberId/insights')
  @RequirePermissions('members.view')
  async getMemberInsight(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<MemberInsight | null> {
    return this.insights.generateMemberInsight(user.organizationId!, memberId);
  }

  @Get(':memberId/insights/churn-reason')
  @RequirePermissions('members.view')
  async getChurnReason(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<MemberInsight | null> {
    return this.insights.generateChurnReason(user.organizationId!, memberId);
  }
}

@Controller('analytics')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AiSegmentInsightsController {
  constructor(private readonly insights: AiInsightsService) {}

  @Post('segments/insights')
  @RequirePermissions('reports.view')
  async getSegmentInsight(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { segmentName: string; memberIds: string[] },
  ): Promise<SegmentInsight | null> {
    return this.insights.generateSegmentInsight(
      user.organizationId!,
      body.segmentName,
      body.memberIds,
    );
  }
}
