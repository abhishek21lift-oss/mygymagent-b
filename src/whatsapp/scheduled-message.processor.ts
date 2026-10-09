import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnrecoverableError, type Job } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import {
  announceBroadcastFinished,
  noteBroadcastSettled,
} from './broadcast-counters';
import type { BroadcastItemJob } from './broadcast.service';
import {
  ScheduledMessageService,
  type ScheduledSendJob,
} from './scheduled-message.service';

/** Fires due scheduled WhatsApp messages, exactly as composed. */
@Processor(QUEUE_NAMES.WA_SCHEDULED)
export class ScheduledMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledMessageProcessor.name);

  constructor(
    private readonly scheduled: ScheduledMessageService,
    private readonly communications: CommunicationsService,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<ScheduledSendJob | BroadcastItemJob>): Promise<void> {
    if (job.name === JOB_NAMES.SEND_SCHEDULED_WHATSAPP) {
      await this.scheduled.fire(
        (job.data as ScheduledSendJob).scheduledMessageId,
      );
      return;
    }
    if (job.name === JOB_NAMES.SEND_BROADCAST_ITEM) {
      await this.fireBroadcastItem(job.data as BroadcastItemJob);
      return;
    }
    throw new UnrecoverableError(`Unknown job "${job.name}"`);
  }

  /**
   * One due broadcast item: same sendAdHoc pipeline as send-now (its
   * settle lands in the wa-send processor); a trigger failure counts
   * here since no wa-send job will ever settle it. Cancelled broadcasts
   * drop their queued items silently.
   */
  private async fireBroadcastItem(data: BroadcastItemJob): Promise<void> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: data.broadcastId },
      select: { organizationId: true, status: true },
    });
    if (
      !broadcast ||
      broadcast.status === 'CANCELLED' ||
      broadcast.status === 'DONE'
    ) {
      return;
    }
    try {
      await this.communications.sendAdHoc({
        organizationId: broadcast.organizationId,
        channel: 'WHATSAPP',
        category: 'TRANSACTIONAL',
        recipient: data.to,
        memberId: data.memberId,
        body: data.text,
        templateKey: 'broadcast',
        mediaKey: data.mediaKey,
        broadcastId: data.broadcastId,
      });
    } catch (error) {
      this.logger.warn(
        `Broadcast item ${data.broadcastId}/${data.memberId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const finished = await noteBroadcastSettled(
        this.prisma,
        data.broadcastId,
        'failed',
      );
      if (finished) {
        await announceBroadcastFinished(
          this.prisma,
          this.events,
          broadcast.organizationId,
          data.broadcastId,
        );
      }
    }
  }
}
