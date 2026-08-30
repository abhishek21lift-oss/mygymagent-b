import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import { AiToolName } from '../tools/tool-definitions';

@Injectable()
export class ActionsSpecialistService extends BaseSpecialistService {
  constructor(aiActionsService: AiActionsService, toolExecutorService: any) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['get_daily_briefing'];
  }
}
