import { Injectable, Logger } from '@nestjs/common';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiToolName } from '../tools/tool-definitions';

export interface SpecialistToolCallContext {
  organizationId: string;
  userId: string;
  requestedBranchId?: string;
}

@Injectable()
export abstract class BaseSpecialistService {
  protected readonly logger: Logger;

  constructor(
    protected readonly toolExecutor: ToolExecutorService,
    protected readonly aiActions: AiActionsService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  async executeTool(
    name: AiToolName,
    rawArgs: unknown,
    context: SpecialistToolCallContext,
  ): Promise<unknown> {
    this.logger.debug(`Specialist executing tool: ${name}`);
    return this.toolExecutor.execute(name, rawArgs, context);
  }

  abstract getHandledTools(): AiToolName[];
}
