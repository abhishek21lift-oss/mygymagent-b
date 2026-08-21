import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
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
  @RequirePermissions('workouts.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWorkoutAssignmentsQueryDto,
  ) {
    return this.workoutAssignmentsService.list(
      user.organizationId!,
      query,
      query.memberId,
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
