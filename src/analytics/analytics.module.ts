import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { FinanceService } from './finance.service';
import { InventoryIntelligenceService } from './inventory-intelligence.service';
import { MemberIntelligenceService } from './member-intelligence.service';
import { MembershipLifecycleAnalyticsService } from './membership-lifecycle-analytics.service';
import { SalesIntelligenceService } from './sales-intelligence.service';
import { TrainerIntelligenceService } from './trainer-intelligence.service';

/**
 * Revenue & Finance (P1) plus Member/Sales/Trainer/Inventory
 * intelligence (P2) and membership lifecycle analytics -- see
 * README.md for what each service computes and what's deliberately
 * flagged as not computable rather than guessed at.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    FinanceService,
    MemberIntelligenceService,
    SalesIntelligenceService,
    TrainerIntelligenceService,
    InventoryIntelligenceService,
    MembershipLifecycleAnalyticsService,
  ],
  exports: [
    FinanceService,
    MemberIntelligenceService,
    SalesIntelligenceService,
    TrainerIntelligenceService,
    InventoryIntelligenceService,
    MembershipLifecycleAnalyticsService,
  ],
})
export class AnalyticsModule {}
