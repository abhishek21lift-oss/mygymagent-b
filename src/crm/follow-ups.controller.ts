import { Controller, Get, Query } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListFollowUpsQueryDto } from './dto/list-follow-ups-query.dto';
import { FollowUpsService } from './follow-ups.service';

@Controller('lead-follow-ups')
export class FollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Get()
  @RequirePermissions('leads.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListFollowUpsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.followUpsService.list(
      user.organizationId!,
      query,
      branchScope,
    );
  }
}
