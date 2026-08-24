import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { WorkoutAssignmentsController } from './workout-assignments.controller';
import { WorkoutAssignmentsService } from './workout-assignments.service';
import { WorkoutExecutionService } from './workout-execution.service';
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
    WorkoutExecutionService,
    ExerciseHistoryService,
  ],
  exports: [ExercisesService, WorkoutPlansService, WorkoutAssignmentsService, WorkoutExecutionService, ExerciseHistoryService],
})
export class WorkoutsModule {}
