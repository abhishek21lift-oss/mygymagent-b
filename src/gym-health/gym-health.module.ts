import { Module } from '@nestjs/common';
import { AiActionsModule } from '../ai-actions/ai-actions.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MemberIntelligenceModule } from '../member-intelligence/member-intelligence.module';
import { CooBriefingService } from './coo-briefing.service';
import { CooTrendsService } from './coo-trends.service';
import { GymHealthController } from './gym-health.controller';
import { GymHealthService } from './gym-health.service';

/**
 * Leaf module: reads the exported analytics + risk services, owns no
 * tables. Importing both parents here (rather than wiring either into
 * the other) avoids a module cycle via AiModule.
 */
@Module({
  imports: [AnalyticsModule, MemberIntelligenceModule, AiActionsModule],
  controllers: [GymHealthController],
  providers: [GymHealthService, CooBriefingService, CooTrendsService],
})
export class GymHealthModule {}
