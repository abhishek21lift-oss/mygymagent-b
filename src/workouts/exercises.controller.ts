import { Body, Controller, Get, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateExerciseDto } from './dto/create-exercise.dto';
import { ExercisesService } from './exercises.service';

@Controller('exercises')
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  @Get()
  // Same library rationale as workout-plans: org reference data with no
  // member linkage, needed by the trainer's plan builder.
  @RequireAnyPermission('workouts.read', 'workouts.read_assigned')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.exercisesService.list(user.organizationId!);
  }

  @Post()
  @RequirePermissions('workouts.create')
  @Audited({ resource: 'exercise', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExerciseDto,
  ) {
    return this.exercisesService.create(user.organizationId!, dto);
  }
}
