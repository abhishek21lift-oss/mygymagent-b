import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnrecoverableError, type Job } from 'bullmq';
import { FileStorageService } from '../files/file-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import {
  announceBroadcastFinished,
  noteBroadcastSettled,
} from '../whatsapp/broadcast-counters';
import { DomainEvent } from '../events/domain-events';
import type { WaSendJob } from './wa-sender.service';
import { WaSessionManager } from './wa-session.manager';
import { NotLinkedError, NotOnWhatsappError } from './wa-types';

/**
 * Sends one queued WhatsApp message and settles its MessageLog row:
 * PENDING (queued) -> SENT with WhatsApp's id (receipts advance it in
 * Phase 2); or FAILED with the reason.
 *
 * One job at a time: the spacing between a gym's messages is set when
 * they are queued, and running them in parallel would undo it.
 */
@Processor(QUEUE_NAMES.WA_SEND, { concurrency: 1 })
export class WaSendProcessor extends WorkerHost {
  private readonly logger = new Logger(WaSendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly manager: WaSessionManager,
    private readonly storage: FileStorageService,
    private readonly events: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<WaSendJob>): Promise<void> {
    if (job.name !== JOB_NAMES.SEND_WHATSAPP_WEB) {
      throw new UnrecoverableError(`Unknown WhatsApp job "${job.name}"`);
    }
    const {
      organizationId,
      messageLogId,
      to,
      text,
      mediaKey,
      replyToMessageId,
      broadcastId,
    } = job.data;
    const log = await this.prisma.messageLog.findFirst({
      where: { id: messageLogId, organizationId },
      select: { status: true, templateKey: true },
    });
    // Already settled (a duplicate job), or the row is gone.
    if (!log || log.status !== 'PENDING') return;

    const fail = async (reason: string) => {
      await this.prisma.messageLog.update({
        where: { id: messageLogId },
        data: {
          status: 'FAILED',
          errorMessage: reason,
          attempts: job.attemptsMade + 1,
        },
      });
      let finished = false;
      if (broadcastId) {
        finished = await noteBroadcastSettled(
          this.prisma,
          broadcastId,
          'failed',
        );
      }
      this.events.emit(DomainEvent.WhatsappFailed, {
        organizationId,
        messageLogId,
        recipient: to,
        templateKey: log.templateKey,
        error: reason,
        ...(broadcastId ? { broadcastId } : {}),
      });
      if (finished && broadcastId) {
        await announceBroadcastFinished(
          this.prisma,
          this.events,
          organizationId,
          broadcastId,
        );
      }
    };

    const succeed = async (id: string) => {
      await this.prisma.messageLog.update({
        where: { id: messageLogId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: `waakg:${id}`,
          attempts: job.attemptsMade + 1,
          errorMessage: null,
        },
      });
      let finished = false;
      if (broadcastId) {
        finished = await noteBroadcastSettled(this.prisma, broadcastId, 'sent');
      }
      this.events.emit(DomainEvent.WhatsappSent, {
        organizationId,
        messageLogId,
        recipient: to,
        templateKey: log.templateKey,
        ...(broadcastId ? { broadcastId } : {}),
      });
      if (finished && broadcastId) {
        await announceBroadcastFinished(
          this.prisma,
          this.events,
          organizationId,
          broadcastId,
        );
      }
    };

    if ((await this.manager.getStatus(organizationId)) !== 'CONNECTED') {
      await fail(
        'The WhatsApp number was disconnected before this message went out.',
      );
      return;
    }

    try {
      if (mediaKey) {
        const file = await this.prisma.file.findFirst({
          where: { id: mediaKey, organizationId },
          select: { key: true, mimeType: true },
        });
        // Validated at enqueue; a file deleted while queued fails the
        // row honestly instead of sending text in its place.
        if (!file || !file.mimeType.startsWith('image/')) {
          await fail('The attached image is no longer available.');
          return;
        }
        const { bytes } = await this.storage.download(file.key);
        const id = await this.manager.sendNow(organizationId, to, {
          image: bytes,
          caption: text,
          mimetype: file.mimeType,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        });
        await succeed(id);
        return;
      }
      const id = await this.manager.sendNow(organizationId, to, {
        text,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      await succeed(id);
    } catch (error) {
      if (error instanceof NotOnWhatsappError) {
        await fail(error.message);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (lastAttempt) {
        await fail(reason);
        return;
      }
      // Most often the socket lives on another server or is reconnecting;
      // retry until it is back.
      if (!(error instanceof NotLinkedError)) {
        this.logger.warn(`WhatsApp send failed, will retry: ${reason}`);
      }
      throw error;
    }
  }
}
