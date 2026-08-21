import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AssignWorkoutPlanDto } from './dto/assign-workout-plan.dto';
import { CreateWorkoutPlanDto } from './dto/create-workout-plan.dto';
import { UpdateWorkoutPlanDto } from './dto/update-workout-plan.dto';
import { WorkoutPlansService } from './workout-plans.service';

@Controller('workout-plans')
export class WorkoutPlansController {
  constructor(private readonly workoutPlansService: WorkoutPlansService) {}

  @Get()
  @RequirePermissions('workouts.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.workoutPlansService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('workouts.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.workoutPlansService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('workouts.create')
  @Audited({ resource: 'workout_plan', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkoutPlanDto,
  ) {
    return this.workoutPlansService.create(user.organizationId!, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('workouts.create')
  @Audited({ resource: 'workout_plan', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkoutPlanDto,
  ) {
    return this.workoutPlansService.update(user.organizationId!, id, dto);
  }

  @Post(':id/assign')
  @RequirePermissions('workouts.assign')
  @Audited({ resource: 'workout_assignment', action: 'create' })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignWorkoutPlanDto,
  ) {
    return this.workoutPlansService.assign(
      user.organizationId!,
      id,
      dto,
      user.id,
    );
  }
}
