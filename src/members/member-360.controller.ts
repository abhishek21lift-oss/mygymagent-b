import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { Member360Service } from './member-360.service';

/// Member 360 aggregations. NOTE on route registration: these static
/// sub-paths (`/members/overview`, `/members/timeline`) MUST stay
/// registered before MembersController's `GET /members/:id` in
/// MembersModule -- otherwise Express matches "overview"/"timeline" as
/// a member id. Same reason MemberTagsController precedes it.
@Controller('members')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class Member360Controller {
  constructor(private readonly member360: Member360Service) {}

  @Get('overview')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.member360.getOverview(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Get('timeline')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @CurrentBranchScope() branchScope?: string | null,
    @CurrentAssignmentScope() assignmentScope?: string | null,
  ) {
    const page = pageRaw ? Number(pageRaw) : 1;
    const pageSize = pageSizeRaw ? Number(pageSizeRaw) : 50;
    return this.member360.getTimeline(
      user.organizationId!,
      memberId,
      Number.isFinite(page) ? page : 1,
      Number.isFinite(pageSize) ? pageSize : 50,
      branchScope ?? null,
      assignmentScope ?? null,
    );
  }
}
