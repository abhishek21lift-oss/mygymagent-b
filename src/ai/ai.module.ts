import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { CrmModule } from '../crm/crm.module';
import { MembersModule } from '../members/members.module';
import { NutritionModule } from '../nutrition/nutrition.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { AiUsageService } from './ai-usage.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { ToolExecutorService } from './tools/tool-executor.service';

/**
 * v1 AI: a single tool-calling chat endpoint over OpenRouter, restricted
 * to the explicit tool allowlist in tools/tool-definitions.ts. See
 * README.md for what's built vs. still-designed-only from
 * docs/ai/architecture.md.
 */
@Module({
  imports: [
    MembersModule,
    AttendanceModule,
    WorkoutsModule,
    CrmModule,
    NutritionModule,
    RbacModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    OpenRouterProvider,
    ToolExecutorService,
    AiUsageService,
  ],
})
export class AiModule {}
