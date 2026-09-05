import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { WorkoutExecutionController } from './workout-execution.controller';
import { WorkoutExecutionService } from './workout-execution.service';
import { WorkoutHistoryController } from './workout-history.controller';
import { WorkoutHistoryService } from './workout-history.service';
import { WorkoutAssignmentsController } from './workout-assignments.controller';
import { WorkoutAssignmentsService } from './workout-assignments.service';
import { WorkoutPlansController } from './workout-plans.controller';
import { WorkoutPlansService } from './workout-plans.service';

/**
 * Workout/PT engine: exercise library, reusable plans, plan assignments,
 * real workout execution, and tenant-scoped workout history.
 */
@Module({
  controllers: [
    ExercisesController,
    WorkoutPlansController,
    WorkoutAssignmentsController,
    WorkoutExecutionController,
    WorkoutHistoryController,
  ],
  providers: [
    ExercisesService,
    WorkoutPlansService,
    WorkoutAssignmentsService,
    WorkoutExecutionService,
    WorkoutHistoryService,
  ],
  exports: [
    ExercisesService,
    WorkoutPlansService,
    WorkoutAssignmentsService,
    WorkoutExecutionService,
    WorkoutHistoryService,
  ],
})
export class WorkoutsModule {}
