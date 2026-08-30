import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { AiToolName } from '../../tools/tool-definitions';
import { validateToolArgs } from '../../tools/validate-tool-args';
import type { Prisma } from '@prisma/client';

export interface SpecialistToolCallContext {
  organizationId: string;
  userId: string;
  requestedBranchId?: string;
}

/**
 * Base class for all AI Specialist agents
 * Provides common functionality and enforces consistent patterns
 */
@Injectable()
export abstract class BaseSpecialistService {
  protected readonly logger: Logger;

  constructor(
    protected readonly toolExecutor: ToolExecutorService,
    protected readonly aiActions: AiActionsService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  /**
   * Execute a tool through the underlying ToolExecutorService
   * This maintains all existing security, permission checking, and audit trails
   */
  protected async executeTool(
    name: AiToolName,
    rawArgs: unknown,
    context: SpecialistToolCallContext,
  ): Promise<unknown> {
    this.logger.debug(
      `Specialist ${this.constructor.name} executing tool: ${name}`,
    );
    return this.toolExecutor.execute(name, rawArgs, {
      organizationId: context.organizationId,
      userId: context.userId,
      requestedBranchId: context.requestedBranchId,
    });
  }

  /**
   * Create a proposal for Action Center tools (propose_* tools)
   * Delegates to AiActionsService to create the pending proposal
   */
  protected async createProposal(
    name: AiToolName,
    rawArgs: unknown,
    context: SpecialistToolCallContext,
  ): Promise<any> {
    this.logger.debug(
      `Specialist ${this.constructor.name} creating proposal for: ${name}`,
    );

    // Map proposal tools to their corresponding AiActionType
    const actionTypeMap: Record<AiToolName, any> = {
      propose_assign_workout_plan: 'ASSIGN_WORKOUT_PLAN',
      propose_assign_diet_plan: 'ASSIGN_DIET_PLAN',
    };

    const actionType = actionTypeMap[name];
    if (!actionType) {
      throw new Error(`No action type mapping for tool: ${name}`);
    }

    // Validate args and create proposal through AiActionsService
    const payload = validateToolArgs(
      // We need to import the appropriate DTO based on the tool
      name === 'propose_assign_workout_plan'
        ? (await import('../ai-actions/dto/assign-plan-payload.dto.ts'))
            .AssignPlanPayloadDto
        : (await import('../ai-actions/dto/assign-plan-payload.dto.ts'))
            .AssignPlanPayloadDto,
      rawArgs,
    );

    return this.aiActions.propose(
      context.organizationId,
      context.userId,
      actionType,
      payload,
    );
  }

  /**
   * Execute an approved Action Center tool
   * Delegates to AiActionsService to execute the approved action
   */
  protected async executeApprovedAction(
    name: AiToolName,
    proposalId: string,
    approvalResult: any,
    context: SpecialistToolCallContext,
  ): Promise<unknown> {
    this.logger.debug(
      `Specialist ${this.constructor.name} executing approved action: ${name}`,
    );

    // Execute the approved action through AiActionsService
    return this.aiActions.executeApprovedAction(
      context.organizationId,
      proposalId,
      approvalResult,
      context.userId,
    );
  }

  /**
   * Abstract method that specialists must implement to declare which tools they handle
   */
  abstract getHandledTools(): AiToolName[];
}
