import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CancelMembershipDto } from './dto/cancel-membership.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { FreezeMembershipDto } from './dto/freeze-membership.dto';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get()
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMembershipsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membershipsService.list(
      user.organizationId!,
      query,
      query.memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membershipsService.getOne(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('memberships.create')
  @Audited({ resource: 'membership', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.create(
      user.organizationId!,
      dto,
      branchScope,
    );
  }

  @Post(':id/freeze')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'freeze' })
  freeze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FreezeMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.freeze(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/resume')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'resume' })
  resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.resume(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Post(':id/cancel')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'cancel' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.cancel(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }
}
