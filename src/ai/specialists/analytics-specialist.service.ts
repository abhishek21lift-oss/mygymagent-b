import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { FinanceService } from '../analytics/finance.service';
import { MemberIntelligenceService } from '../analytics/member-intelligence.service';
import { SalesIntelligenceService } from '../analytics/sales-intelligence.service';
import { TrainerIntelligenceService } from '../analytics/trainer-intelligence.service';
import { InventoryIntelligenceService } from '../analytics/inventory-intelligence.service';
import { AiToolName } from '../tools/tool-definitions';

@Injectable()
export class AnalyticsSpecialistService extends BaseSpecialistService {
  constructor(
    financeService: FinanceService,
    memberIntelligenceService: MemberIntelligenceService,
    salesIntelligenceService: SalesIntelligenceService,
    trainerIntelligenceService: TrainerIntelligenceService,
    inventoryIntelligenceService: InventoryIntelligenceService,
    aiActionsService: any,
    toolExecutorService: any,
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
