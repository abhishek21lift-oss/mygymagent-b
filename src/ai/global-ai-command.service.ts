import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { AiSupervisorService } from './supervisor/ai-supervisor.service';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import { AiToolName } from './tools/tool-definitions';
import { validateToolArgs } from './tools/validate-tool-args';
import type { Prisma } from '@prisma/client';

export interface GlobalCommandRequest {
  organizationId: string;
  userId: string;
  command: string;
  context?: Record<string, unknown>;
}

export interface GlobalCommandResponse {
  type: 'response' | 'approval_required' | 'error';
  content: string;
  data?: unknown;
  actionId?: string;
  requiresApproval?: boolean;
  suggestedTools?: string[];
}

@Injectable()
export class GlobalAiCommandService {
  private readonly logger = new Logger(GlobalAiCommandService.name);

  constructor(
    private readonly supervisor: AiSupervisorService,
    private readonly aiActions: AiActionsService,
  ) {}

  /**
   * Process a global AI command request
   * Determines if it's a read-only question or actionable request
   * Executes the appropriate tool(s) via AI Supervisor
   * Returns structured response
   */
  async processCommand(
    request: GlobalCommandRequest,
  ): Promise<GlobalCommandResponse> {
    this.logger.debug(`Processing global AI command: ${request.command}`);

    try {
      // Parse command to determine intent and extract parameters
      const { toolName, args, isActionable } = await this.parseCommand(
        request.command,
        request.context,
      );

      // Execute the tool via AI Supervisor
      let result: unknown;
      if (isActionable) {
        // For actionable commands, we need to go through approval workflow
        result = await this.supervisor.executeWithApproval(
          toolName,
          args,
          {
            organizationId: request.organizationId,
            userId: request.userId,
            requestedBranchId: request.context && typeof request.context === 'object' && 'branchId' in request.context
              ? String(request.context['branchId'])
              : undefined,
          },
          request.userId, // The user requesting the action is also the approver for self-service
        );
      } else {
        // For read-only commands, execute directly
        result = await this.supervisor.execute(
          toolName,
          args,
          {
            organizationId: request.organizationId,
            userId: request.userId,
            requestedBranchId: request.context && typeof request.context === 'object' && 'branchId' in request.context
              ? String(request.context['branchId'])
              : undefined,
          },
        );
      }

      // Log the successful interaction
      await this.logCommandInteraction(request, {
        type: isActionable ? 'approval_required' : 'response',
        content: `Successfully executed ${toolName}`,
        data: result,
        requiresApproval: isActionable,
      });

      // Return appropriate response
      if (isActionable) {
        return {
          type: 'approval_required',
          content: `I've prepared a proposal to ${this.getActionDescription(
            toolName,
            args,
          )}. This requires approval before it can be executed.`,
          data: {
            tool: toolName,
            args,
            result,
          },
          requiresApproval: true,
        };
      } else {
        return {
          type: 'response',
          content: this.formatToolResult(toolName, result),
          data: result,
        };
      }
    } catch (error) {
      this.logger.error(`Error processing global AI command: ${error.message}`);

      // Log the failed interaction
      await this.logCommandInteraction(request, {
        type: 'error',
        content: `Failed to process command: ${error.message}`,
      });

      return {
        type: 'error',
        content: `I encountered an error while processing your request: ${error.message}`,
      };
    }
  }

  /**
   * Parse the command to determine which tool to use and extract arguments
   * Uses pattern matching to identify user intent
   */
  private async parseCommand(
    command: string,
    context?: Record<string, unknown>,
  ): Promise<{
    toolName: AiToolName;
    args: unknown;
    isActionable: boolean;
  }> {
    const cmdLower = command.toLowerCase().trim();

    // Member information queries
    if (
      cmdLower.includes('member') &&
      (cmdLower.includes('expire') ||
        cmdLower.includes('expiring') ||
        cmdLower.includes('membership')) &&
      cmdLower.includes('next 7 days')
    ) {
      // This would require knowing which members to check - for now, we'll need member ID
      // In a real implementation, we might ask for clarification or use context
      throw new Error(
        'To check member membership expiration, please specify which member ID',
      );
    }

    if (
      cmdLower.includes('member') &&
      (cmdLower.includes('inactive') ||
        cmdLower.includes('not visited') ||
        cmdLower.includes('haven\'t visited')) &&
      (cmdLower.includes('recently') || cmdLower.includes('lately'))
    ) {
      // Similar issue - need member ID
      throw new Error(
        'To check member inactivity, please specify which member ID',
      );
    }

    // Analytics queries
    if (
      cmdLower.includes('gym performing') ||
      cmdLower.includes('how is my gym') ||
      cmdLower.includes('gym performance') ||
      (cmdLower.includes('performance') && cmdLower.includes('this month'))
    ) {
      return {
        toolName: 'get_revenue_summary',
        args: {},
        isActionable: false,
      };
    }

    if (
      cmdLower.includes('revenue') &&
      cmdLower.includes('this month')
    ) {
      return {
        toolName: 'get_revenue_summary',
        args: {},
        isActionable: false,
      };
    }

    if (
      cmdLower.includes('at risk') ||
      cmdLower.includes('at-risk') ||
      (cmdLower.includes('risk') && cmdLower.includes('member'))
    ) {
      return {
        toolName: 'get_at_risk_members',
        args: {},
        isActionable: false,
      };
    }

    if (
      cmdLower.includes('sales funnel') ||
      cmdLower.includes('funnel')
    ) {
      return {
        toolName: 'get_sales_funnel',
        args: {},
        isActionable: false,
      };
    }

    if (
      cmdLower.includes('trainer workload') ||
      cmdLower.includes('workload') &&
      cmdLower.includes('trainer')
    ) {
      return {
        toolName: 'get_trainer_workload',
        args: {},
        isActionable: false,
      };
    }

    if (
      cmdLower.includes('inventory') ||
      cmdLower.includes('stock') ||
      cmdLower.includes('forecast')
    ) {
      return {
        toolName: 'get_inventory_forecast',
        args: {},
        isActionable: false,
      };
    }

    // Action commands
    if (
      cmdLower.includes('follow-up') ||
      cmdLower.includes('followup') ||
      cmdLower.includes('create follow up')
    ) {
      if (
        cmdLower.includes('high-risk') ||
        cmdLower.includes('high risk') ||
        cmdLower.includes('at risk')
      ) {
        // This would need member IDs - for now, indicate we need more info
        throw new Error(
          'To create follow-up tasks for high-risk members, please specify which member IDs or let me identify at-risk members first',
        );
      }

      // General follow-up creation - would need lead ID
      throw new Error(
        'To create a follow-up task, please specify which lead ID',
      );
    }

    if (
      cmdLower.includes('send message') ||
      cmdLower.includes('send approved message') ||
      cmdLower.includes('message to')
    ) {
      throw new Error(
        'To send messages, please specify which members and what message content',
      );
    }

    // Default fallback - if we can't determine a specific tool, ask for clarification
    throw new Error(
      `I couldn't understand your request: "${command}". Please try being more specific. For example, you could ask about member information, revenue reports, attendance records, or request to create follow-up tasks.`,
    );
  }

  /**
   * Format tool results into a user-friendly response
   */
  private formatToolResult(toolName: AiToolName, result: unknown): string {
    switch (toolName) {
      case 'get_revenue_summary':
        return `Here's your gym's revenue summary for this month:\n${JSON.stringify(
          result,
          null,
          2,
        )}`;
      case 'get_at_risk_members':
        const members = result as Array<any>;
        if (members.length === 0) {
          return 'Great news! There are currently no at-risk members.';
        }
        return `Here are the at-risk members:\n${members
          .map(
            (m, idx) =>
              `${idx + 1}. ${m.memberId}: ${m.daysSinceCheckIn || 'Never checked in'} days`,
          )
          .join('\n')}`;
      case 'get_sales_funnel':
        return `Here's your sales funnel:\n${JSON.stringify(
          result,
          null,
          2,
        )}`;
      case 'get_trainer_workload':
        return `Here's your trainer workload:\n${JSON.stringify(
          result,
          null,
          2,
        )}`;
      case 'get_inventory_forecast':
        return `Here's your inventory forecast:\n${JSON.stringify(
          result,
          null,
          2,
        )}`;
      default:
        return `Here's the result from ${toolName}:\n${JSON.stringify(
          result,
          null,
          2,
        )}`;
    }
  }

  /**
   * Get a description of what the action will do for approval requests
   */
  private getActionDescription(
    toolName: AiToolName,
    args: unknown,
  ): string {
    switch (toolName) {
      case 'create_followup':
        return `create a follow-up task`;
      case 'propose_assign_workout_plan':
        return `assign a workout plan to a member`;
      case 'propose_assign_diet_plan':
        return `assign a diet plan to a member`;
      default:
        return `perform the action ${toolName}`;
    }
  }

  /**
   * Log the command interaction for audit purposes
   */
  private async logCommandInteraction(
    request: GlobalCommandRequest,
    response: GlobalCommandResponse,
  ): Promise<void> {
    this.logger.debug(
      `Global AI Command - User: ${request.userId}, Org: ${request.organizationId}, Command: "${request.command}", Response Type: ${response.type}`,
    );

    // In a full implementation, this would store to database for audit trail
    // For now, we log to the service logger which is captured in application logs
  }
}