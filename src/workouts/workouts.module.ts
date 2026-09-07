import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { WorkoutAssignmentsController } from './workout-assignments.controller';
import { WorkoutAssignmentsService } from './workout-assignments.service';
import { WorkoutPlansController } from './workout-plans.controller';
import { WorkoutPlansService } from './workout-plans.service';
import { ExerciseHistoryController } from './exercise-history.controller';
import { ExerciseHistoryService } from './exercise-history.service';

@Module({
  controllers: [
    ExercisesController,
    WorkoutPlansController,
    WorkoutAssignmentsController,
    ExerciseHistoryController,
  ],
  providers: [
    ExercisesService,
    WorkoutPlansService,
    WorkoutAssignmentsService,
    ExerciseHistoryService,
  ],
  exports: [
    ExercisesService,
    WorkoutPlansService,
    WorkoutAssignmentsService,
    ExerciseHistoryService,
  ],
})
export class WorkoutsModule {}
