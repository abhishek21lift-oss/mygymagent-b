import { Module } from '@nestjs/common';
import { AiActionsModule } from '../ai-actions/ai-actions.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { BriefingModule } from '../briefing/briefing.module';
import { CrmModule } from '../crm/crm.module';
import { MembersModule } from '../members/members.module';
import { NutritionModule } from '../nutrition/nutrition.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { AiUsageService } from './ai-usage.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiConversationsController } from './conversations/ai-conversations.controller';
import { AiConversationsService } from './conversations/ai-conversations.service';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { ToolExecutorService } from './tools/tool-executor.service';
import { AiSupervisorService } from './supervisor/ai-supervisor.service';
import { GlobalAiCommandController } from './global-ai-command.controller';
import { GlobalAiCommandService } from './global-ai-command.service';

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
    AnalyticsModule,
    AiActionsModule,
    BriefingModule,
  ],
  controllers: [
    AiController,
    AiConversationsController,
    GlobalAiCommandController,
  ],
  providers: [
    AiService,
    OpenRouterProvider,
    ToolExecutorService,
    AiUsageService,
    AiConversationsService,
    AiSupervisorService,
    GlobalAiCommandService,
  ],
})
export class AiModule {}