import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';

/**
 * Specialist routing for high-risk AI actions.
 * Actual proposal creation/approval/execution stays centralized in the
 * Action Center services and ToolExecutorService.
 */
@Injectable()
export class ActionsSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return [
      'propose_assign_workout_plan',
      'propose_assign_diet_plan',
    ];
  }
}
