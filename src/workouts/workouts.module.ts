import { Module } from '@nestjs/common';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { WorkoutAssignmentsController } from './workout-assignments.controller';
import { WorkoutAssignmentsService } from './workout-assignments.service';
import { WorkoutExecutionService } from './workout-execution.service';
import { WorkoutPlansController } from './workout-plans.controller';
import { WorkoutPlansService } from './workout-plans.service';

@Module({
  controllers: [ExercisesController, WorkoutPlansController, WorkoutAssignmentsController],
  providers: [ExercisesService, WorkoutPlansService, WorkoutAssignmentsService, WorkoutExecutionService],
  exports: [ExercisesService, WorkoutPlansService, WorkoutAssignmentsService, WorkoutExecutionService],
})
export class WorkoutsModule {}
