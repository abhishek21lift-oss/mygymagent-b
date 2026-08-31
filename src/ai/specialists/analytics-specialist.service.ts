import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { FinanceService } from '../../analytics/finance.service';
import { MemberIntelligenceService } from '../../analytics/member-intelligence.service';
import { SalesIntelligenceService } from '../../analytics/sales-intelligence.service';
import { TrainerIntelligenceService } from '../../analytics/trainer-intelligence.service';
import { InventoryIntelligenceService } from '../../analytics/inventory-intelligence.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';

@Injectable()
export class AnalyticsSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
    private readonly financeService: FinanceService,
    private readonly memberIntelligenceService: MemberIntelligenceService,
    private readonly salesIntelligenceService: SalesIntelligenceService,
    private readonly trainerIntelligenceService: TrainerIntelligenceService,
    private readonly inventoryIntelligenceService: InventoryIntelligenceService,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return [
      'get_revenue_summary',
      'get_at_risk_members',
      'get_sales_funnel',
      'get_trainer_workload',
      'get_inventory_forecast',
    ];
  }
}
