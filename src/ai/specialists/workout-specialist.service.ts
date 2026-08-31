import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { WorkoutPlansService } from '../../workouts/workout-plans.service';
import { WorkoutAssignmentsService } from '../../workouts/workout-assignments.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';

@Injectable()
export class WorkoutSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
    private readonly workoutPlansService: WorkoutPlansService,
    private readonly workoutAssignmentsService: WorkoutAssignmentsService,
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
