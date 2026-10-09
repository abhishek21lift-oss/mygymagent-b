import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import {
  DomainEvent,
  type BroadcastFinishedEvent,
  type WhatsappConnectionEvent,
  type WhatsappFailedEvent,
  type WhatsappReceivedEvent,
  type WhatsappSentEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { matches } from './webhook-events';

export interface WebhookJobData {
  subscriptionId: string;
  deliveryId: string;
  organizationId: string;
  event: string;
  data: Record<string, unknown>;
}

/**
 * Fans domain events out to gym-registered webhook URLs: one PENDING
 * delivery row + one queue job per matching subscription. The processor
 * owns retries; this side never POSTs. T5 adds the remaining events;
 * every one funnels through `fanOut` below.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.WA_WEBHOOKS) private readonly queue: Queue,
  ) {}

  @OnEvent(DomainEvent.WhatsappReceived, { async: true })
  async onReceived(event: WhatsappReceivedEvent): Promise<void> {
    try {
      await this.dispatchReceived(event);
    } catch (error) {
      this.logger.warn(
        `Webhook fan-out for ${event.inboundMessageId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  @OnEvent(DomainEvent.WhatsappSent, { async: true })
  async onSent(event: WhatsappSentEvent): Promise<void> {
    await this.fanOutSafe(event.organizationId, 'message.sent', {
      messageLogId: event.messageLogId,
      recipient: event.recipient,
      templateKey: event.templateKey,
      broadcastId: event.broadcastId ?? null,
    });
  }

  @OnEvent(DomainEvent.WhatsappFailed, { async: true })
  async onFailed(event: WhatsappFailedEvent): Promise<void> {
    await this.fanOutSafe(event.organizationId, 'message.failed', {
      messageLogId: event.messageLogId,
      recipient: event.recipient,
      templateKey: event.templateKey,
      error: event.error,
      broadcastId: event.broadcastId ?? null,
    });
  }

  @OnEvent(DomainEvent.BroadcastFinished, { async: true })
  async onBroadcastFinished(event: BroadcastFinishedEvent): Promise<void> {
    await this.fanOutSafe(event.organizationId, 'broadcast.finished', {
      broadcastId: event.broadcastId,
      status: event.status,
      total: event.total,
      sent: event.sent,
      failed: event.failed,
      skipped: event.skipped,
    });
  }

  @OnEvent(DomainEvent.WhatsappConnection, { async: true })
  async onConnection(event: WhatsappConnectionEvent): Promise<void> {
    await this.fanOutSafe(event.organizationId, 'connection.update', {
      status: event.status,
    });
  }

  /** Fan-out that never breaks the emitter: a dead receiver URL must not
   * fail the send/file/connect flow that announced the event. */
  private async fanOutSafe(
    organizationId: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.fanOut(organizationId, event, data);
    } catch (error) {
      this.logger.warn(
        `Webhook fan-out for ${event} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async dispatchReceived(event: WhatsappReceivedEvent): Promise<number> {
    const message = await this.prisma.inboundMessage.findUnique({
      where: { id: event.inboundMessageId },
      select: {
        from: true,
        body: true,
        matchedMemberId: true,
        groupJid: true,
      },
    });
    // Row gone (retention): nothing truthful to send.
    if (!message) return 0;
    return this.fanOut(event.organizationId, 'message.received', {
      inboundMessageId: event.inboundMessageId,
      from: message.from,
      body: message.body,
      matchedMemberId: message.matchedMemberId,
      isGroup: event.isGroup ?? false,
      groupJid: event.groupJid ?? null,
    });
  }

  /** Queue one job per matching subscription; returns jobs queued. */
  private async fanOut(
    organizationId: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    const subs = await this.prisma.webhookSubscription.findMany({
      where: { organizationId, enabled: true },
      take: 10,
    });
    let queued = 0;
    for (const sub of subs.filter((s) => matches(s.events, event))) {
      const delivery = await this.prisma.webhookDelivery.create({
        data: { organizationId, subscriptionId: sub.id, event },
        select: { id: true },
      });
      await this.queue.add(
        JOB_NAMES.DELIVER_WEBHOOK,
        {
          subscriptionId: sub.id,
          deliveryId: delivery.id,
          organizationId,
          event,
          data,
        } satisfies WebhookJobData,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: `wl-${delivery.id}`,
        },
      );
      queued += 1;
    }
    return queued;
  }
}
