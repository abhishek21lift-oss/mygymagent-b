import { Module } from '@nestjs/common';
import { NutritionModule } from '../nutrition/nutrition.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { AiActionsController } from './ai-actions.controller';
import { AiActionsService } from './ai-actions.service';

/**
 * The Action Center (P3): READ -> RECOMMEND -> DRAFT -> APPROVE -> EXECUTE
 * for AI-proposed changes -- see AiActionsService's class comment. The AI
 * tools that create proposals live in AiModule (`src/ai/tools/`), not
 * here -- this module owns the approval workflow and its REST surface,
 * imported by AiModule the same way AnalyticsModule is.
 */
@Module({
  imports: [RbacModule, WorkoutsModule, NutritionModule],
  controllers: [AiActionsController],
  providers: [AiActionsService],
  exports: [AiActionsService],
})
export class AiActionsModule {}
