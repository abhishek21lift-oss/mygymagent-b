import { Module } from '@nestjs/common';
import { RiskEngineController } from './risk-engine.controller';
import { RiskEngineService } from './risk-engine.service';
import { IntelligenceAnalyticsController } from './intelligence-analytics.controller';
import { IntelligenceAnalyticsService } from './intelligence-analytics.service';
import { ChurnEngineController } from './churn-engine.controller';
import { ChurnEngineService } from './churn-engine.service';
import {
  AiInsightsController,
  AiSegmentInsightsController,
} from './ai-insights.controller';
import { AiInsightsService } from './ai-insights.service';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule],
  controllers: [
    RiskEngineController,
    IntelligenceAnalyticsController,
    ChurnEngineController,
    AiInsightsController,
    AiSegmentInsightsController,
    RecommendationsController,
    SegmentsController,
  ],
  providers: [
    RiskEngineService,
    IntelligenceAnalyticsService,
    ChurnEngineService,
    AiInsightsService,
    RecommendationsService,
    SegmentsService,
  ],
  exports: [
    RiskEngineService,
    IntelligenceAnalyticsService,
    ChurnEngineService,
    AiInsightsService,
    RecommendationsService,
    SegmentsService,
  ],
})
export class MemberIntelligenceModule {}
