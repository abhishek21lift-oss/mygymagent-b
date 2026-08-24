import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { WorkoutExecutionController } from './workout-execution.controller';
import { WorkoutExecutionService } from './workout-execution.service';
import { WorkoutAssignmentsController } from './workout-assignments.controller';
import { WorkoutAssignmentsService } from './workout-assignments.service';
import { WorkoutPlansController } from './workout-plans.controller';
import { WorkoutPlansService } from './workout-plans.service';

/**
 * Workout/PT engine: exercise library, reusable plans, plan assignments,
 * and real workout execution/history.
 */
@Module({
  controllers: [
    ExercisesController,
    WorkoutPlansController,
    WorkoutAssignmentsController,
    WorkoutExecutionController,
  ],
  providers: [
    ExercisesService,
    WorkoutPlansService,
    WorkoutAssignmentsService,
    WorkoutExecutionService,
  ],
  exports: [
    ExercisesService,
    WorkoutPlansService,
    WorkoutAssignmentsService,
    WorkoutExecutionService,
  ],
})
export class WorkoutsModule {}
