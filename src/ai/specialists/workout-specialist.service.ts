import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { WorkoutPlansService } from '../../workouts/workout-plans.service';
import { WorkoutAssignmentsService } from '../../workouts/workout-assignments.service';
import { AiToolName } from '../../tools/tool-definitions';

@Injectable()
export class WorkoutSpecialistService extends BaseSpecialistService {
  constructor(
    workoutPlansService: WorkoutPlansService,
    workoutAssignmentsService: WorkoutAssignmentsService,
    aiActionsService: any,
    toolExecutorService: any,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return [
      'read_workout_history',
      'create_workout_draft',
      'propose_assign_workout_plan',
    ];
  }
}
