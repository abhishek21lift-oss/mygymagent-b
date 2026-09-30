import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { WhatsappWebManager } from './whatsapp-web.manager';
import {
  NotOnWhatsappError,
  WhatsappWebNotReadyError,
  type SendWhatsappWebJob,
} from './whatsapp-web.types';

/**
 * Sends one queued WhatsApp Web message and settles its MessageLog row:
 * PENDING (queued) -> SENT with WhatsApp's id, from which the manager's
 * receipt handler advances it to DELIVERED and READ; or FAILED with the
 * reason.
 *
 * One job at a time: the spacing between a gym's messages is set when
 * they are queued, and running them in parallel would undo it.
 */
@Processor(QUEUE_NAMES.WHATSAPP_WEB, { concurrency: 1 })
export class WhatsappWebProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsappWebProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly manager: WhatsappWebManager,
  ) {
    super();
  }

  async process(job: Job<SendWhatsappWebJob>): Promise<void> {
    if (job.name !== JOB_NAMES.SEND_WHATSAPP_WEB) {
      throw new UnrecoverableError(`Unknown WhatsApp Web job "${job.name}"`);
    }
    const { organizationId, messageLogId, to, text } = job.data;
    const log = await this.prisma.messageLog.findFirst({
      where: { id: messageLogId, organizationId },
      select: { status: true },
    });
    // Already settled (a duplicate job), or the row is gone.
    if (!log || log.status !== 'PENDING') return;

    const fail = (reason: string) =>
      this.prisma.messageLog.update({
        where: { id: messageLogId },
        data: {
          status: 'FAILED',
          errorMessage: reason,
          attempts: job.attemptsMade + 1,
        },
      });

    const session = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (session?.status !== 'CONNECTED') {
      await fail(
        'The WhatsApp Web number was disconnected before this message went out.',
      );
      return;
    }

    try {
      const id = await this.manager.send(organizationId, to, text);
      await this.prisma.messageLog.update({
        where: { id: messageLogId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: `waweb:${id}`,
          attempts: job.attemptsMade + 1,
          errorMessage: null,
        },
      });
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
      if (!(error instanceof WhatsappWebNotReadyError)) {
        this.logger.warn(`WhatsApp Web send failed, will retry: ${reason}`);
      }
      throw error;
    }
  }
}
