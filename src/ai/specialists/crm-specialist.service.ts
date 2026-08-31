import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { LeadsService } from '../../crm/leads.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';

@Injectable()
export class CrmSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
    private readonly leadsService: LeadsService,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['create_followup'];
  }
}
