import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import {
  WebhookBlockedError,
  WebhookHttpError,
  postWebhook,
} from './webhook-send';
import type { WebhookJobData } from './webhook-dispatcher.service';

const FALLBACK_ATTEMPTS = 3;
const FALLBACK_BACKOFF_MS = 60_000;

/**
 * POSTs one queued webhook delivery. Retryable failures rethrow for
 * BullMQ (attempts/backoff ride on the job); refusals and vanished
 * subscriptions fail the row immediately without retrying.
 */
@Processor(QUEUE_NAMES.WA_WEBHOOKS, {
  limiter: { max: 20, duration: 1_000 },
})
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    if (job.name !== JOB_NAMES.DELIVER_WEBHOOK) {
      throw new UnrecoverableError(`Unknown webhook job "${job.name}"`);
    }
    const { subscriptionId, deliveryId, organizationId, event, data } =
      job.data;
    const sub = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, organizationId },
    });
    if (!sub || !sub.enabled) {
      await this.fail(job, deliveryId, 'subscription removed');
      throw new UnrecoverableError(
        `Webhook subscription ${subscriptionId} is gone`,
      );
    }
    try {
      const { httpStatus } = await postWebhook(sub.url, sub.secret, {
        event,
        organizationId,
        timestamp: new Date().toISOString(),
        data,
      });
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SENT',
          attempts: job.attemptsMade + 1,
          httpStatus,
          error: null,
          nextRetryAt: null,
        },
      });
    } catch (error) {
      if (error instanceof WebhookBlockedError) {
        await this.fail(job, deliveryId, error.message);
        throw new UnrecoverableError(error.message);
      }
      const maxAttempts =
        typeof job.opts.attempts === 'number'
          ? job.opts.attempts
          : FALLBACK_ATTEMPTS;
      if (job.attemptsMade + 1 >= maxAttempts) {
        await this.fail(
          job,
          deliveryId,
          describe(error),
          error instanceof WebhookHttpError ? error.httpStatus : null,
        );
        throw error;
      }
      const backoff = job.opts.backoff;
      const delayMs =
        typeof backoff === 'number'
          ? backoff
          : (backoff?.delay ?? FALLBACK_BACKOFF_MS);
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'PENDING',
          attempts: job.attemptsMade + 1,
          httpStatus:
            error instanceof WebhookHttpError ? error.httpStatus : null,
          error: describe(error),
          nextRetryAt: new Date(Date.now() + delayMs * 2 ** job.attemptsMade),
        },
      });
      throw error;
    }
  }

  private fail(
    job: Job<WebhookJobData>,
    deliveryId: string,
    reason: string,
    httpStatus: number | null = null,
  ): Promise<unknown> {
    this.logger.warn(`Webhook delivery ${deliveryId} failed: ${reason}`);
    return this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'FAILED',
        attempts: job.attemptsMade + 1,
        httpStatus,
        error: reason.slice(0, 500),
        nextRetryAt: null,
      },
    });
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}
