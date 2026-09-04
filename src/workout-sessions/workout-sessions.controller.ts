import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import type { LogWorkoutSetDto } from './dto/log-workout-set.dto';
import { WorkoutSessionsService } from './workout-sessions.service';

/**
 * Workout execution: starting a session from an active assignment, logging
 * sets per exercise, and completing the session. Reads accept both
 * `workouts.read` (org-wide) and `workouts.read_assigned` (trainer-scoped);
 * writes require `workouts.assign`. See workouts/README.md.
 */
@Controller('workout-sessions')
export class WorkoutSessionsController {
  constructor(
    private readonly workoutSessionsService: WorkoutSessionsService,
  ) {}

  @Get('today')
  @RequireAnyPermission('workouts.read', 'workouts.read_assigned')
  listToday(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.workoutSessionsService.listToday(
      user.organizationId!,
      assignmentScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('workouts.read', 'workouts.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.workoutSessionsService.getOne(
      user.organizationId!,
      id,
      assignmentScope,
    );
  }

  @Post('assignment/:assignmentId/start')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session', action: 'start' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId') assignmentId: string,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.workoutSessionsService.start(
      user.organizationId!,
      assignmentId,
      user.id,
      assignmentScope,
    );
  }

  @Post(':sessionId/exercises/:sessionExerciseId/sets')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session_set', action: 'log' })
  logSet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Param('sessionExerciseId') sessionExerciseId: string,
    @Body() dto: LogWorkoutSetDto,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.workoutSessionsService.logSet(
      user.organizationId!,
      sessionId,
      sessionExerciseId,
      dto,
      assignmentScope,
    );
  }

  @Patch(':id/complete')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session', action: 'complete' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.workoutSessionsService.complete(
      user.organizationId!,
      id,
      user.id,
      assignmentScope,
    );
  }
}
