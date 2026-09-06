import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
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
import {
  CreateMemberFollowUpDto,
  UpdateMemberFollowUpDto,
} from './dto/member-follow-up.dto';
import { MemberFollowUpsService } from './member-follow-ups.service';

@Controller('members/:memberId/follow-ups')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberFollowUpsController {
  constructor(private readonly followUps: MemberFollowUpsService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.list(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':followUpId')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('followUpId') followUpId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.getOne(
      user.organizationId!,
      memberId,
      followUpId,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_follow_up', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberFollowUpDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.create(
      user.organizationId!,
      memberId,
      dto,
      user.id,
      branchScope,
      assignmentScope,
    );
  }

  @Patch(':followUpId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_follow_up', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('followUpId') followUpId: string,
    @Body() dto: UpdateMemberFollowUpDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.update(
      user.organizationId!,
      memberId,
      followUpId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Put(':followUpId/complete')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_follow_up', action: 'complete' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('followUpId') followUpId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.complete(
      user.organizationId!,
      memberId,
      followUpId,
      branchScope,
      assignmentScope,
    );
  }

  @Put(':followUpId/uncomplete')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_follow_up', action: 'uncomplete' })
  uncomplete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('followUpId') followUpId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.uncomplete(
      user.organizationId!,
      memberId,
      followUpId,
      branchScope,
      assignmentScope,
    );
  }

  @Delete(':followUpId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_follow_up', action: 'delete' })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('followUpId') followUpId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.followUps.delete(
      user.organizationId!,
      memberId,
      followUpId,
      branchScope,
      assignmentScope,
    );
  }
}
