import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListWorkoutAssignmentsQueryDto } from './dto/list-workout-assignments-query.dto';
import { UpdateWorkoutAssignmentStatusDto } from './dto/update-workout-assignment-status.dto';
import { WorkoutAssignmentsService } from './workout-assignments.service';

@Controller('workout-assignments')
export class WorkoutAssignmentsController {
  constructor(
    private readonly workoutAssignmentsService: WorkoutAssignmentsService,
  ) {}

  @Get()
  @RequireAnyPermission('workouts.read', 'workouts.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWorkoutAssignmentsQueryDto,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.workoutAssignmentsService.list(
      user.organizationId!,
      query,
      query.memberId,
      assignmentScope,
    );
  }

  @Patch(':id/status')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_assignment', action: 'update_status' })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkoutAssignmentStatusDto,
  ) {
    return this.workoutAssignmentsService.updateStatus(
      user.organizationId!,
      id,
      dto,
    );
  }
}
