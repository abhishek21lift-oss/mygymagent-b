import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { DailyBriefingService } from '../../briefing/daily-briefing.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';

@Injectable()
export class BriefingSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
    private readonly dailyBriefingService: DailyBriefingService,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['get_daily_briefing'];
  }
}
