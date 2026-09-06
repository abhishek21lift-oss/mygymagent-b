import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMemberAssessmentDto } from './dto/member-assessment.dto';
import { CreateMemberFitnessTestDto } from './dto/member-fitness-test.dto';
import { CreateMemberMeasurementDto } from './dto/member-measurement.dto';
import { CreateMemberScreeningDto } from './dto/member-screening.dto';
import { MemberAssessmentsService } from './member-assessments.service';

@Controller('members/:memberId')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberAssessmentsController {
  constructor(private readonly assessments: MemberAssessmentsService) {}

  @Get('assessments')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listAssessments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.listAssessments(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('assessments')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_assessment', action: 'create' })
  createAssessment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberAssessmentDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.createAssessment(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Get('measurements')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listMeasurements(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.listMeasurements(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('measurements')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_measurement', action: 'create' })
  createMeasurement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberMeasurementDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.createMeasurement(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Get('fitness-tests')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listFitnessResults(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.listFitnessResults(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('fitness-tests')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_fitness_test', action: 'create' })
  createFitnessResult(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberFitnessTestDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.createFitnessResult(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Get('screenings')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listScreenings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.listScreenings(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('screenings')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_screening', action: 'create' })
  createScreening(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberScreeningDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.assessments.createScreening(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }
}
