import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { WorkoutHistoryQueryDto } from './dto/workout-history-query.dto';
import { WorkoutHistoryService } from './workout-history.service';

@Controller('workout-history')
export class WorkoutHistoryController {
  constructor(private readonly workoutHistory: WorkoutHistoryService) {}

  @Get('members/:memberId')
  @RequirePermissions('workouts.read')
  memberHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Query() query: WorkoutHistoryQueryDto,
  ) {
    return this.workoutHistory.memberHistory(
      user.organizationId!,
      memberId,
      user.primaryBranchId,
      query.limit,
    );
  }

  @Get('members/:memberId/exercises/:exerciseId')
  @RequirePermissions('workouts.read')
  exerciseHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('exerciseId') exerciseId: string,
    @Query() query: WorkoutHistoryQueryDto,
  ) {
    return this.workoutHistory.exerciseHistory(
      user.organizationId!,
      memberId,
      exerciseId,
      user.primaryBranchId,
      query.limit,
    );
  }
}
