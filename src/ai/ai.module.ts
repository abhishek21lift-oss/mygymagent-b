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
import { FreeLLMApiProvider } from './providers/freellmapi.provider';
import { ToolExecutorService } from './tools/tool-executor.service';
import { AiSupervisorService } from './supervisor/ai-supervisor.service';
import { GlobalAiCommandController } from './global-ai-command.controller';
import { GlobalAiCommandService } from './global-ai-command.service';

/**
 * v1 AI: tool-calling chat over the deployment's OpenAI-compatible
 * FreeLLMAPI gateway, restricted to the explicit tool allowlist.
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
    FreeLLMApiProvider,
    ToolExecutorService,
    AiUsageService,
    AiConversationsService,
    AiSupervisorService,
    GlobalAiCommandService,
  ],
})
export class AiModule {}
