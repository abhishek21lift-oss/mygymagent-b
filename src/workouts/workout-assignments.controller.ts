import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListWorkoutAssignmentsQueryDto } from './dto/list-workout-assignments-query.dto';
import { UpdateWorkoutAssignmentStatusDto } from './dto/update-workout-assignment-status.dto';
import { UpdateWorkoutSessionDto } from './dto/workout-session.dto';
import { WorkoutAssignmentsService } from './workout-assignments.service';

@Controller('workout-assignments')
export class WorkoutAssignmentsController {
  constructor(private readonly workoutAssignmentsService: WorkoutAssignmentsService) {}

  @Get('today-sessions')
  @RequirePermissions('workouts.read')
  todaysSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.workoutAssignmentsService.todaysSessions(user.organizationId!);
  }

  @Get()
  @RequirePermissions('workouts.read')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListWorkoutAssignmentsQueryDto) {
    return this.workoutAssignmentsService.list(user.organizationId!, query, query.memberId, query.status);
  }

  @Post(':id/session/start')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session', action: 'start' })
  startSession(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.workoutAssignmentsService.startSession(user.organizationId!, id, user.id);
  }

  @Patch(':id/session')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session', action: 'update' })
  updateSession(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateWorkoutSessionDto) {
    return this.workoutAssignmentsService.updateSession(user.organizationId!, id, dto.status, dto.notes);
  }

  @Patch(':id/status')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_assignment', action: 'update_status' })
  updateStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateWorkoutAssignmentStatusDto) {
    return this.workoutAssignmentsService.updateStatus(user.organizationId!, id, dto);
  }
}
