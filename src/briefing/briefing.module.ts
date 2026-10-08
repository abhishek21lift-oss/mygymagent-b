import { Module } from '@nestjs/common';
import { AiActionsModule } from '../ai-actions/ai-actions.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { DailyBriefingController } from './daily-briefing.controller';
import { DailyBriefingService } from './daily-briefing.service';
import { OwnerOsService } from './owner-os.service';

/**
 * The Owner Daily Briefing (P3): aggregates P1/P2's analytics services
 * and P3's Action Center backlog into one real, computed report -- see
 * DailyBriefingService's class comment. No new data source.
 *
 * OwnerOsService is the executive-shaped sibling (headline metrics,
 * severity-ranked alerts, advisory recommendations) for the AI agent's
 * get_owner_briefing tool. Both read today's figures from
 * TodayFiguresService, the source behind the dashboard.
 */
@Module({
  imports: [AnalyticsModule, AiActionsModule],
  controllers: [DailyBriefingController],
  providers: [DailyBriefingService, OwnerOsService],
  exports: [DailyBriefingService, OwnerOsService],
})
export class BriefingModule {}
