import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ExerciseHistoryQueryDto } from './dto/exercise-history-query.dto';
import { ExerciseHistoryService } from './exercise-history.service';

@Controller('workouts')
export class ExerciseHistoryController {
  constructor(private readonly exerciseHistoryService: ExerciseHistoryService) {}

  @Get('exercise-history')
  @RequirePermissions('workouts.read')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExerciseHistoryQueryDto,
  ) {
    return this.exerciseHistoryService.getMemberExerciseHistory(
      user.organizationId!,
      query.memberId,
      query.exerciseId,
      query.limit,
    );
  }
}
