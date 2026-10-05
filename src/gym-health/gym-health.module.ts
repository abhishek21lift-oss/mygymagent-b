import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MemberIntelligenceModule } from '../member-intelligence/member-intelligence.module';
import { GymHealthController } from './gym-health.controller';
import { GymHealthService } from './gym-health.service';

/**
 * Leaf module: reads the exported analytics + risk services, owns no
 * tables. Importing both parents here (rather than wiring either into
 * the other) avoids a module cycle via AiModule.
 */
@Module({
  imports: [AnalyticsModule, MemberIntelligenceModule],
  controllers: [GymHealthController],
  providers: [GymHealthService],
})
export class GymHealthModule {}
