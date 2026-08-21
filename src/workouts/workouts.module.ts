import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { WorkoutAssignmentsController } from './workout-assignments.controller';
import { WorkoutAssignmentsService } from './workout-assignments.service';
import { WorkoutPlansController } from './workout-plans.controller';
import { WorkoutPlansService } from './workout-plans.service';

/**
 * v1 workout/PT engine: exercise library, named workout plans (ordered
 * exercises with sets/reps/rest), and assigning a plan to a member with
 * status tracking. See README.md for the scope decision (a full
 * Program -> Phase -> Week -> Day -> Workout -> Exercise -> Set hierarchy
 * was deliberately deferred as over-engineering for a first pass).
 */
@Module({
  controllers: [
    ExercisesController,
    WorkoutPlansController,
    WorkoutAssignmentsController,
  ],
  providers: [ExercisesService, WorkoutPlansService, WorkoutAssignmentsService],
  exports: [ExercisesService, WorkoutPlansService, WorkoutAssignmentsService],
})
export class WorkoutsModule {}
