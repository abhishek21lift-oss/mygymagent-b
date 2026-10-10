import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { AiUsageService } from '../ai/ai-usage.service';
import { OpenRouterProvider } from '../ai/providers/openrouter.provider';
import { organizationTimezone } from '../common/time/zoned';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import {
  AnalysisValidationError,
  buildAnalysisMessages,
  extractJson,
  noteText,
  proposalsFrom,
  validateAnalysis,
  type CallAnalysis,
} from './call-analysis';

/** A second request for the same note within this window is a double click. */
const IN_FLIGHT_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Runs a saved call note through the AI, off the request path: the call is
 * saved first and the receptionist never waits on the model. The result
 * is advisory -- proposals staff approve or reject -- and a failure leaves
 * the note exactly as typed, with manual task creation untouched.
 */
@Injectable()
export class CallAnalysisService {
  private readonly logger = new Logger(CallAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: OpenRouterProvider,
    private readonly usage: AiUsageService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_NAMES.AUTOMATION) private readonly queue: Queue,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.get<string>('OPENROUTER_API_KEY'));
  }

  /**
   * Queue (or re-queue) the analysis. Retrying replaces only proposals still
   * pending; approved or rejected ones, and the tasks they made, stay.
   */
  async request(
    organizationId: string,
    callLogId: string,
    opts: { retry?: boolean } = {},
  ) {
    const call = await this.prisma.callLog.findFirst({
      where: { id: callLogId, organizationId },
      select: {
        id: true,
        analysisStatus: true,
        updatedAt: true,
        response: true,
        internalNotes: true,
        reason: true,
      },
    });
    if (!call) return null;
    if (!noteText({ outcome: '', ...call }).trim()) {
      return this.prisma.callLog.update({
        where: { id: callLogId },
        data: {
          analysisStatus: 'NOT_REQUESTED',
          analysisError: 'There is no note to analyse.',
        },
        select: { id: true, analysisStatus: true, analysisError: true },
      });
    }
    if (
      opts.retry &&
      call.analysisStatus === 'PENDING' &&
      Date.now() - call.updatedAt.getTime() < IN_FLIGHT_MS
    ) {
      throw new ConflictException('This note is already being analysed.');
    }
    if (!this.configured) {
      return this.prisma.callLog.update({
        where: { id: callLogId },
        data: {
          analysisStatus: 'FAILED',
          analysisError:
            'AI is not configured on this deployment. Create follow-ups by hand.',
        },
        select: { id: true, analysisStatus: true, analysisError: true },
      });
    }
    const updated = await this.prisma.callLog.update({
      where: { id: callLogId },
      data: { analysisStatus: 'PENDING', analysisError: null },
      select: { id: true, analysisStatus: true, analysisError: true },
    });
    await this.queue
      .add(
        JOB_NAMES.ANALYZE_CALL_NOTE,
        { organizationId, callLogId },
        {
          // One queued job per note at a time; a retry after it finished
          // gets a fresh id.
          jobId: `analyze-call-${callLogId}-${Date.now()}`,
          attempts: MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 10_000 },
        },
      )
      .catch(async (error: unknown) => {
        this.logger.error(
          `Could not queue analysis for ${callLogId}: ${String(error)}`,
        );
        await this.prisma.callLog.update({
          where: { id: callLogId },
          data: {
            analysisStatus: 'FAILED',
            analysisError: 'Could not start the analysis. Retry.',
          },
        });
      });
    return updated;
  }

  /**
   * The job body. Throws only on a transient provider error with attempts
   * left, so BullMQ retries it with backoff; every other failure is
   * recorded on the call and the job ends.
   */
  async run(
    organizationId: string,
    callLogId: string,
    finalAttempt: boolean,
  ): Promise<void> {
    const call = await this.prisma.callLog.findFirst({
      where: { id: callLogId, organizationId },
    });
    if (!call || call.analysisStatus !== 'PENDING') return;
    await this.prisma.callLog.update({
      where: { id: callLogId },
      data: { analysisAttempts: { increment: 1 } },
    });
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const note = {
      outcome: call.outcome,
      reason: call.reason,
      response: call.response,
      internalNotes: call.internalNotes,
    };
    const ctx = { timezone, calledAt: call.calledAt };
    const started = Date.now();

    let analysis: CallAnalysis;
    try {
      const messages = buildAnalysisMessages(note, ctx);
      const first = await this.provider.chatCompletion(messages, {
        tools: false,
      });
      this.recordUsage(call, first.model, first.usage, started, 'SUCCESS');
      try {
        analysis = validateAnalysis(
          extractJson(first.message.content ?? ''),
          note,
          ctx,
        );
      } catch (error) {
        if (!(error instanceof AnalysisValidationError)) throw error;
        // One correction round: models often wrap or truncate JSON.
        const second = await this.provider.chatCompletion(
          [
            ...messages,
            { role: 'assistant', content: first.message.content ?? '' },
            {
              role: 'user',
              content: `That reply was rejected (${error.message}). Reply again with only the JSON object.`,
            },
          ],
          { tools: false },
        );
        this.recordUsage(call, second.model, second.usage, started, 'SUCCESS');
        analysis = validateAnalysis(
          extractJson(second.message.content ?? ''),
          note,
          ctx,
        );
      }
    } catch (error) {
      const transient =
        error instanceof HttpException &&
        [429, 502, 503, 504].includes(error.getStatus());
      if (transient && !finalAttempt) throw error;
      const message =
        error instanceof AnalysisValidationError
          ? `The AI reply could not be used: ${error.message}`
          : error instanceof HttpException
            ? error.message
            : 'The AI analysis failed.';
      this.logger.warn(`Call ${callLogId} analysis failed: ${message}`);
      this.recordUsage(call, undefined, undefined, started, 'ERROR', message);
      await this.prisma.callLog.update({
        where: { id: callLogId },
        data: {
          analysisStatus: 'FAILED',
          analysisError: message.slice(0, 300),
        },
      });
      return;
    }

    const drafts = proposalsFrom(analysis);
    await this.prisma.$transaction(async (tx) => {
      // Re-check: an edit or retry while we were waiting restarts the run.
      const current = await tx.callLog.findUnique({
        where: { id: callLogId },
        select: { analysisStatus: true, updatedAt: true },
      });
      if (current?.analysisStatus !== 'PENDING') return;
      await tx.actionProposal.deleteMany({
        where: { callLogId, status: 'PENDING' },
      });
      if (drafts.length) {
        await tx.actionProposal.createMany({
          data: drafts.map((d) => ({
            organizationId,
            callLogId,
            memberId: call.memberId,
            leadId: call.leadId,
            kind: d.kind,
            title: d.title,
            details: d.details,
            explicit: d.explicit,
            evidence: d.evidence,
            suggestedDueAt: d.suggestedDueAt,
            dueAtNeedsConfirmation: d.dueAtNeedsConfirmation,
            suggestedPriority: d.suggestedPriority,
            amount: d.amount === null ? null : new Prisma.Decimal(d.amount),
          })),
        });
      }
      await tx.callLog.update({
        where: { id: callLogId },
        data: {
          analysisStatus: 'COMPLETED',
          analysisError: null,
          analyzedAt: new Date(),
          analysis: JSON.parse(
            JSON.stringify(analysis),
          ) as Prisma.InputJsonValue,
        },
      });
    });
  }

  private recordUsage(
    call: { organizationId: string; recordedByUserId: string | null },
    model: string | undefined,
    usage:
      | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          costUsd?: number;
        }
      | undefined,
    started: number,
    status: 'SUCCESS' | 'ERROR',
    errorMessage?: string,
  ): void {
    if (!call.recordedByUserId) return;
    void this.usage.record({
      organizationId: call.organizationId,
      userId: call.recordedByUserId,
      feature: 'call-note-analysis',
      provider: 'openrouter',
      model,
      ...usage,
      latencyMs: Date.now() - started,
      status,
      errorMessage,
    });
  }
}
