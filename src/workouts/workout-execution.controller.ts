import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateWorkoutSessionDto } from './dto/create-workout-session.dto';
import { LogWorkoutSetDto } from './dto/log-workout-set.dto';
import { WorkoutExecutionService } from './workout-execution.service';

@Controller('workout-sessions')
export class WorkoutExecutionController {
  constructor(private readonly workoutExecutionService: WorkoutExecutionService) {}

  @Get('today')
  @RequirePermissions('workouts.read')
  listToday(@CurrentUser() user: AuthenticatedUser) {
    return this.workoutExecutionService.listToday(
      user.organizationId!,
      user.primaryBranchId,
    );
  }

  @Post('assignment/:assignmentId/start')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session', action: 'start' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: CreateWorkoutSessionDto,
  ) {
    return this.workoutExecutionService.createSession(
      user.organizationId!,
      user.primaryBranchId,
      assignmentId,
      dto,
    );
  }

  @Post(':sessionId/exercises/:sessionExerciseId/sets')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_set', action: 'log' })
  logSet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Param('sessionExerciseId') sessionExerciseId: string,
    @Body() dto: LogWorkoutSetDto,
  ) {
    return this.workoutExecutionService.logSet(
      user.organizationId!,
      sessionId,
      sessionExerciseId,
      user.primaryBranchId,
      dto,
    );
  }

  @Patch(':sessionId/complete')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_session', action: 'complete' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.workoutExecutionService.completeSession(
      user.organizationId!,
      sessionId,
      user.primaryBranchId,
    );
  }

  @Get(':sessionId')
  @RequirePermissions('workouts.read')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.workoutExecutionService.getSession(
      user.organizationId!,
      sessionId,
      user.primaryBranchId,
    );
  }
}
