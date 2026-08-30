import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { SpecialistFactoryService } from './specialist-factory.service';
import { AiToolName } from '../tools/tool-definitions';
import { validateToolArgs } from '../tools/validate-tool-args';
import type { Prisma } from '@prisma/client';

export interface SupervisorToolCallContext {
  organizationId: string;
  userId: string;
  requestedBranchId?: string;
}

/**
 * AI Supervisor (P3): Routes AI tool requests to appropriate specialist agents
 * while preserving all existing security boundaries and permission checking.
 *
 * The Supervisor does not replace existing services - it coordinates them.
 * All tool execution still goes through existing domain services via the
 * ToolExecutorService to maintain security and audit trails.
 */
@Injectable()
export class AiSupervisorService {
  private readonly logger = new Logger(AiSupervisorService.name);

  constructor(
    private readonly toolExecutor: ToolExecutorService,
    private readonly aiActions: AiActionsService,
    private readonly specialistFactory: SpecialistFactoryService,
  ) {}

  /**
   * Execute a tool request through the appropriate specialist
   * Maintains identical interface to ToolExecutorService.execute() for backward compatibility
   */
  async execute(
    name: AiToolName,
    rawArgs: unknown,
    context: SupervisorToolCallContext,
  ): Promise<unknown> {
    this.logger.debug(`Supervisor executing tool: ${name}`);

    // Get the appropriate specialist for this tool
    const specialist = this.specialistFactory.getSpecialistForTool(name);

    // Execute through the specialist (which will delegate to ToolExecutorService internally)
    return specialist.executeTool(name, rawArgs, context);
  }

  /**
   * Execute a tool that requires approval (Action Center tools)
   * Handles the full approval workflow: proposal -> approval -> execution
   */
  async executeWithApproval(
    name: AiToolName,
    rawArgs: unknown,
    context: SupervisorToolCallContext,
    approverUserId: string,
  ): Promise<unknown> {
    this.logger.debug(`Supervisor executing tool with approval: ${name}`);

    // First, create the proposal through the specialist
    const specialist = this.specialistFactory.getSpecialistForTool(name);
    const proposal = await specialist.createProposal(name, rawArgs, context);

    // Then get approval through the Action Center
    const approvalResult = await this.aiActions.approve(
      context.organizationId,
      proposal.id,
      approverUserId,
    );

    // Finally, execute the approved action
    return specialist.executeApprovedAction(
      name,
      proposal.id,
      approvalResult,
      context,
    );
  }
}
