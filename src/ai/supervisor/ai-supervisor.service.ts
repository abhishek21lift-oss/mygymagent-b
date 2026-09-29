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

  /**
   * Propose an AI write and route it to the Action Center.
   *
   * There is deliberately **no approval step in this method.** It used to
   * take an `approverUserId` and call `approve()` itself, and the only
   * caller passed the requesting user as that approver — so the write was
   * proposed and executed inside one request by the same person, and the
   * approval workflow on the AI write path was decorative. The
   * `approve` call checked that its caller held `workouts.assign` or
   * `nutrition.assign`, which the requester usually does, so nothing
   * stood between an LLM's reading of a sentence and a workout plan
   * being assigned to a real member.
   *
   * What it returns now is the proposal: a `PENDING_APPROVAL` row that a
   * *different* person with the right permission has to accept in the
   * Action Center. `approve` is unchanged, and still refuses a
   * non-`PENDING_APPROVAL` row, so this cannot be double-approved.
   *
   * The name is kept rather than renamed to avoid churning the call site;
   * it means "execute through the approval flow", not "approve".
   */
  async executeWithApproval(
    name: AiToolName,
    rawArgs: unknown,
    context: SupervisorToolCallContext,
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
    const required: {
      memberId: string;
      planId: string;
      startDate?: string;
      notes?: string;
    } = {
      memberId: payload.memberId,
      planId: payload.planId,
      ...(payload.startDate ? { startDate: payload.startDate } : {}),
      ...(payload.notes ? { notes: payload.notes } : {}),
    };

    const proposal =
      name === 'propose_assign_workout_plan'
        ? await this.aiActions.proposeAssignPlan(
            context.organizationId,
            context.userId,
            'ASSIGN_WORKOUT_PLAN',
            required,
          )
        : await this.aiActions.proposeAssignPlan(
            context.organizationId,
            context.userId,
            'ASSIGN_DIET_PLAN',
            required,
          );

    // Stop here. The proposal waits in the Action Center for someone
    // other than the person who asked for it.
    return proposal;
  }
}
