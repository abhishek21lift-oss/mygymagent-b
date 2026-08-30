import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { DietPlansService } from '../../nutrition/diet-plans.service';
import { AiToolName } from '../../tools/tool-definitions';

@Injectable()
export class NutritionSpecialistService extends BaseSpecialistService {
  constructor(
    dietPlansService: DietPlansService,
    aiActionsService: any,
    toolExecutorService: any,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['create_diet_draft', 'propose_assign_diet_plan'];
  }
}
