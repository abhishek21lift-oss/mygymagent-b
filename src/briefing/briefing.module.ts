import { Module } from '@nestjs/common';
import { AiActionsModule } from '../ai-actions/ai-actions.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { DailyBriefingController } from './daily-briefing.controller';
import { DailyBriefingService } from './daily-briefing.service';

/**
 * The Owner Daily Briefing (P3): aggregates P1/P2's analytics services
 * and P3's Action Center backlog into one real, computed report -- see
 * DailyBriefingService's class comment. No new data source.
 */
@Module({
  imports: [AnalyticsModule, AiActionsModule],
  controllers: [DailyBriefingController],
  providers: [DailyBriefingService],
  exports: [DailyBriefingService],
})
export class BriefingModule {}
