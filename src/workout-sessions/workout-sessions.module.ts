import { Module } from '@nestjs/common';
import { WorkoutSessionsController } from './workout-sessions.controller';
import { WorkoutSessionsService } from './workout-sessions.service';

/**
 * Workout execution layer: one WorkoutSession per time a member actually
 * runs an assigned workout plan, with exercises snapshotted from the plan
 * at start time and logged sets appended per exercise. Sits on top of the
 * workouts module's WorkoutPlan/WorkoutAssignment shape (the v1 scope
 * decision there deferred execution; this is that missing layer -- see
 * README.md).
 */
@Module({
  controllers: [WorkoutSessionsController],
  providers: [WorkoutSessionsService],
  exports: [WorkoutSessionsService],
})
export class WorkoutSessionsModule {}
