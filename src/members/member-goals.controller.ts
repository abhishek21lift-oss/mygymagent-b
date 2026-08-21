import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateMemberGoalMilestoneDto,
  UpdateMemberGoalMilestoneDto,
} from './dto/member-goal-milestone.dto';
import {
  CreateMemberGoalDto,
  UpdateMemberGoalDto,
} from './dto/member-goal.dto';
import { MemberGoalsService } from './member-goals.service';

@Controller('members/:memberId/goals')
export class MemberGoalsController {
  constructor(private readonly goals: MemberGoalsService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.goals.listGoals(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_goal', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberGoalDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.goals.createGoal(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Patch(':goalId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_goal', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('goalId') goalId: string,
    @Body() dto: UpdateMemberGoalDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.goals.updateGoal(
      user.organizationId!,
      memberId,
      goalId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Post(':goalId/milestones')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_goal_milestone', action: 'create' })
  createMilestone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('goalId') goalId: string,
    @Body() dto: CreateMemberGoalMilestoneDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.goals.createMilestone(
      user.organizationId!,
      memberId,
      goalId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Patch(':goalId/milestones/:milestoneId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_goal_milestone', action: 'update' })
  updateMilestone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('goalId') goalId: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: UpdateMemberGoalMilestoneDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.goals.updateMilestone(
      user.organizationId!,
      memberId,
      goalId,
      milestoneId,
      dto,
      branchScope,
      assignmentScope,
    );
  }
}
