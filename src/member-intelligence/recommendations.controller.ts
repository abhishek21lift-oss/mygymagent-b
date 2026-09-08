import {
  Controller,
  Get,
  Post,
  Param,
  Patch,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { RecommendationsService } from './recommendations.service';
import { ActionStatus } from '@prisma/client';

@Controller('members/:memberId/recommendations')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  @RequirePermissions('members.view')
  async getRecommendations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Query('status') status?: ActionStatus,
  ) {
    return this.recommendations.getRecommendations(
      user.organizationId!,
      memberId,
      status,
    );
  }

  @Post('generate')
  @RequirePermissions('members.view')
  async generateRecommendations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    const recommendations = await this.recommendations.generateRecommendations(
      user.organizationId!,
      memberId,
    );
    return this.recommendations.createRecommendations(
      user.organizationId!,
      memberId,
      recommendations,
    );
  }

  @Post(':actionId/execute')
  @RequirePermissions('members.edit')
  async executeRecommendation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.recommendations.executeRecommendation(
      user.organizationId!,
      actionId,
      user.id,
    );
  }

  @Patch(':actionId/dismiss')
  @RequirePermissions('members.edit')
  async dismissRecommendation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.recommendations.dismissRecommendation(
      user.organizationId!,
      actionId,
    );
  }
}
