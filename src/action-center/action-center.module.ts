import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { RbacModule } from '../rbac/rbac.module';
import { ActionCenterController } from './action-center.controller';
import { ActionCenterService } from './action-center.service';
import { CallAnalysisService } from './call-analysis.service';
import { CallLogsController } from './call-logs.controller';
import { CallLogsService } from './call-logs.service';
import { ProposalsService } from './proposals.service';
import { TaskGeneratorService } from './task-generator.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * Daily Action Center: worklist tasks, call logging, AI call-note
 * proposals and the daily task generator. Its scheduled jobs run on the
 * `automation` queue's processor (AutomationModule imports this module).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.AUTOMATION }),
    AiModule,
    AnalyticsModule,
    NotificationsModule,
    RbacModule,
  ],
  controllers: [TasksController, CallLogsController, ActionCenterController],
  providers: [
    TasksService,
    CallLogsService,
    CallAnalysisService,
    ProposalsService,
    TaskGeneratorService,
    ActionCenterService,
  ],
  exports: [TaskGeneratorService, ActionCenterService, CallAnalysisService],
})
export class ActionCenterModule {}
