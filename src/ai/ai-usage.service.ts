import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AiUsageRecord {
  organizationId: string;
  userId: string;
  feature: string;
  provider: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs: number;
  status: 'SUCCESS' | 'ERROR';
  errorMessage?: string;
  requestId?: string;
}

/**
 * Writes one AiUsageLog row per user-facing AI request. See the model
 * comment in schema.prisma for why this exists (cost visibility + the
 * data plan-limit enforcement will eventually read from).
 *
 * Logging usage must never be able to fail the actual AI response --
 * every call site awaits this from inside its own try/catch and this
 * method never throws.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AiUsageRecord): Promise<void> {
    try {
      await this.prisma.aiUsageLog.create({
        data: {
          organizationId: entry.organizationId,
          userId: entry.userId,
          feature: entry.feature,
          provider: entry.provider,
          model: entry.model,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.costUsd,
          latencyMs: entry.latencyMs,
          status: entry.status,
          errorMessage: entry.errorMessage,
          requestId: entry.requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record AI usage log: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
