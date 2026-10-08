import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import type { ScheduleWhatsAppMessageDto } from './dto/whatsapp.dto';

export interface ScheduledSendJob {
  scheduledMessageId: string;
}

/**
 * Staff-composed one-off WhatsApp messages, sent at a future time.
 * Storage is a row; delivery is a delayed BullMQ job. Cancelling removes
 * both. Firing goes through the normal `sendAdHoc` pipeline, so consent
 * gating and delivery logging behave exactly like an immediate send.
 */
@Injectable()
export class ScheduledMessageService {
  private readonly logger = new Logger(ScheduledMessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    @InjectQueue(QUEUE_NAMES.WA_SCHEDULED) private readonly queue: Queue,
  ) {}

  async schedule(
    organizationId: string,
    userId: string,
    dto: ScheduleWhatsAppMessageDto,
  ) {
    const to = dto.to.trim();
    const text = dto.text.trim();
    if (!to || !text) {
      throw new BadRequestException('to and text are required');
    }
    const sendAt = new Date(dto.sendAt);
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
      throw new BadRequestException('sendAt must be a future datetime');
    }
    const row = await this.prisma.scheduledMessage.create({
      data: {
        organizationId,
        recipient: to,
        body: text,
        memberId: dto.memberId,
        sendAt,
        status: 'PENDING',
        createdByUserId: userId,
      },
    });
    const job: ScheduledSendJob = { scheduledMessageId: row.id };
    await this.queue.add(JOB_NAMES.SEND_SCHEDULED_WHATSAPP, job, {
      delay: Math.max(0, sendAt.getTime() - Date.now()),
      jobId: `wa-sched-${row.id}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    });
    return row;
  }

  list(organizationId: string, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.scheduledMessage.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async cancel(organizationId: string, id: string) {
    const row = await this.prisma.scheduledMessage.findFirst({
      where: { id, organizationId },
    });
    if (!row || row.status !== 'PENDING') {
      throw new NotFoundException(
        'Scheduled message not found, already sent or cancelled.',
      );
    }
    await this.queue.remove(`wa-sched-${id}`).catch(() => undefined);
    return this.prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  /** Fired by the delayed job. Non-PENDING rows never send twice. */
  async fire(id: string): Promise<void> {
    const row = await this.prisma.scheduledMessage.findFirst({
      where: { id },
    });
    if (!row || row.status !== 'PENDING') return;
    try {
      const sent = await this.communications.sendAdHoc({
        organizationId: row.organizationId,
        channel: 'WHATSAPP',
        category: 'TRANSACTIONAL',
        recipient: row.recipient,
        memberId: row.memberId ?? undefined,
        body: row.body,
        templateKey: 'scheduled',
      });
      const failed = (sent as { status?: string })?.status === 'FAILED';
      await this.prisma.scheduledMessage.update({
        where: { id },
        data: {
          status: failed ? 'FAILED' : 'SENT',
          messageLogId: (sent as { id?: string })?.id,
          ...(failed
            ? {
                errorMessage:
                  (sent as { errorMessage?: string })?.errorMessage ??
                  'Send failed',
              }
            : {}),
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scheduled WhatsApp ${id} failed: ${reason}`);
      await this.prisma.scheduledMessage.update({
        where: { id },
        data: { status: 'FAILED', errorMessage: reason },
      });
    }
  }
}
