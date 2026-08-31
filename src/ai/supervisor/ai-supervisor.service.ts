import { Injectable, Logger } from '@nestjs/common';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { SpecialistFactoryService } from './specialist-factory.service';
import { AiToolName } from '../tools/tool-definitions';

export interface SupervisorToolCallContext {
  organizationId: string;
  userId: string;
  requestedBranchId?: string;
}

@Injectable()
export class AiSupervisorService {
  private readonly logger = new Logger(AiSupervisorService.name);

  constructor(
    private readonly toolExecutor: ToolExecutorService,
    private readonly aiActions: AiActionsService,
    private readonly specialistFactory: SpecialistFactoryService,
  ) {}

  async execute(
    name: AiToolName,
    rawArgs: unknown,
    context: SupervisorToolCallContext,
  ): Promise<unknown> {
    this.logger.debug(`Supervisor executing tool: ${name}`);
    const specialist = this.specialistFactory.getSpecialistForTool(name);
    return specialist.executeTool(name, rawArgs, context);
  }

  async executeWithApproval(
    name: AiToolName,
    rawArgs: unknown,
    context: SupervisorToolCallContext,
    approverUserId: string,
  ): Promise<unknown> {
    this.logger.debug(`Supervisor executing tool with approval: ${name}`);
    const payload = rawArgs as {
      memberId?: string;
      planId?: string;
      startDate?: string;
      notes?: string;
    };
    if (!payload.memberId || !payload.planId) {
      throw new Error('Approval tool requires memberId and planId');
    }

    const proposal = name === 'propose_assign_workout_plan'
      ? await this.aiActions.proposeAssignPlan(
          context.organizationId,
          context.userId,
          'ASSIGN_WORKOUT_PLAN',
          payload,
        )
      : await this.aiActions.proposeAssignPlan(
          context.organizationId,
          context.userId,
          'ASSIGN_DIET_PLAN',
          payload,
        );

    return this.aiActions.approve(
      context.organizationId,
      proposal.id,
      approverUserId,
    );
  }
}
