import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { LeadsService } from '../../crm/leads.service';
import { AiToolName } from '../../tools/tool-definitions';

@Injectable()
export class CrmSpecialistService extends BaseSpecialistService {
  constructor(
    leadsService: LeadsService,
    aiActionsService: any,
    toolExecutorService: any,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['create_followup'];
  }
}
