import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { DailyBriefingService } from '../briefing/daily-briefing.service';
import { AiToolName } from '../tools/tool-definitions';

@Injectable()
export class BriefingSpecialistService extends BaseSpecialistService {
  constructor(
    dailyBriefingService: DailyBriefingService,
    aiActionsService: any,
    toolExecutorService: any,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['get_daily_briefing'];
  }
}
