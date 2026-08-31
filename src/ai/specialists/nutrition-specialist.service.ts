import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { DietPlansService } from '../../nutrition/diet-plans.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';

@Injectable()
export class NutritionSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
    private readonly dietPlansService: DietPlansService,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['create_diet_draft', 'propose_assign_diet_plan'];
  }
}
