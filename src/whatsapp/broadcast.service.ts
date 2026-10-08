import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import { SegmentsService } from '../member-intelligence/segments.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { DomainEvent } from '../events/domain-events';
import { WhatsappService } from './whatsapp.service';

export interface CreateBroadcastDto {
  segmentId: string;
  text: string;
  mediaKey?: string;
  /** ISO datetime with offset; absent means send now. */
  sendAt?: string;
}

export interface BroadcastItemJob {
  broadcastId: string;
  memberId: string;
  to: string;
  text: string;
  mediaKey?: string;
}

/**
 * One staff-composed message to a whole segment (P3), fanned out over
 * the normal queues: now → `sendAdHoc` per member (which queues paced
 * `wa-send` jobs); future → delayed `wa-sched` broadcast-item jobs that
 * trigger the same `sendAdHoc` when due. Per-recipient consent, pacing
 * and daily-limit checks are the existing ones -- this service only
 * resolves the audience and counts the outcome.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentsService,
    private readonly communications: CommunicationsService,
    private readonly whatsapp: WhatsappService,
    @InjectQueue(QUEUE_NAMES.WA_SCHEDULED) private readonly queue: Queue,
    private readonly events: EventEmitter2,
  ) {}

  async create(
    organizationId: string,
    userId: string,
    dto: CreateBroadcastDto,
  ) {
    const text = dto.text.trim();
    if (!text) throw new BadRequestException('text is required');
    let sendAt: Date | null = null;
    if (dto.sendAt) {
      sendAt = new Date(dto.sendAt);
      if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
        throw new BadRequestException('sendAt must be a future datetime');
      }
    }
    if (dto.mediaKey) {
      await this.whatsapp.assertSendableImage(organizationId, dto.mediaKey);
    }
    // 404 for missing/foreign segments propagates -- nothing enqueued.
    const audience = await this.segments.getSegmentPhones(
      organizationId,
      dto.segmentId,
    );
    const emailable = audience.filter((a) => a.phone?.trim());
    const skipped = audience.length - emailable.length;
    if (emailable.length === 0) {
      throw new BadRequestException('Segment has no sendable members');
    }
    const broadcast = await this.prisma.broadcast.create({
      data: {
        organizationId,
        segmentId: dto.segmentId,
        body: text,
        mediaFileId: dto.mediaKey,
        sendAt,
        status: sendAt ? 'PENDING' : 'SENDING',
        total: emailable.length,
        skipped,
        createdByUserId: userId,
      },
    });

    if (sendAt) {
      const delay = Math.max(0, sendAt.getTime() - Date.now());
      for (const m of emailable) {
        const job: BroadcastItemJob = {
          broadcastId: broadcast.id,
          memberId: m.memberId,
          to: m.phone!.trim(),
          text,
          ...(dto.mediaKey ? { mediaKey: dto.mediaKey } : {}),
        };
        await this.queue.add(JOB_NAMES.SEND_BROADCAST_ITEM, job, {
          delay,
          jobId: `wa-bcast-${broadcast.id}-${m.memberId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
        });
      }
      return this.prisma.broadcast.update({
        where: { id: broadcast.id },
        data: { queued: emailable.length },
      });
    }

    let queued = 0;
    let failed = 0;
    for (const m of emailable) {
      // Outcomes are counted at settle time, not here: SKIPPED inside
      // sendAdHoc, SENT/FAILED in the wa-send processor, trigger failures
      // below. Only a throw here means no job ever existed.
      try {
        await this.communications.sendAdHoc({
          organizationId,
          channel: 'WHATSAPP',
          category: 'TRANSACTIONAL',
          recipient: m.phone!.trim(),
          memberId: m.memberId,
          body: text,
          templateKey: 'broadcast',
          mediaKey: dto.mediaKey,
          broadcastId: broadcast.id,
        });
        queued += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Broadcast ${broadcast.id} failed for ${m.memberId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const settled = failed + skipped >= emailable.length;
    const row = await this.prisma.broadcast.update({
      where: { id: broadcast.id },
      data: {
        queued,
        failed,
        status: settled ? 'DONE' : 'SENDING',
      },
    });
    if (settled) {
      this.events.emit(DomainEvent.BroadcastFinished, {
        organizationId,
        broadcastId: row.id,
        status: 'DONE',
        total: row.total,
        sent: row.sent,
        failed: row.failed,
        skipped: row.skipped,
      });
    }
    return row;
  }

  async progress(organizationId: string, id: string) {
    const row = await this.prisma.broadcast.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException('Broadcast not found');
    return row;
  }

  list(organizationId: string, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.broadcast.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Stops a PENDING (scheduled) broadcast: removes its delayed jobs.
   * In-flight `wa-send` jobs already queued still send -- cancelling
   * unsends nothing. DONE/CANCELLED rows are 404: counters are frozen.
   */
  async cancel(organizationId: string, id: string) {
    const row = await this.prisma.broadcast.findFirst({
      where: { id, organizationId },
    });
    if (!row || row.status === 'DONE' || row.status === 'CANCELLED') {
      throw new NotFoundException(
        'Broadcast not found, already sent or cancelled.',
      );
    }
    if (row.status === 'PENDING') {
      const audience = await this.segments.getSegmentPhones(
        organizationId,
        row.segmentId,
      );
      for (const m of audience) {
        await this.queue
          .remove(`wa-bcast-${row.id}-${m.memberId}`)
          .catch(() => undefined);
      }
    }
    const cancelled = await this.prisma.broadcast.update({
      where: { id: row.id },
      data: { status: 'CANCELLED' },
    });
    this.events.emit(DomainEvent.BroadcastFinished, {
      organizationId,
      broadcastId: cancelled.id,
      status: 'CANCELLED',
      total: row.total,
      sent: row.sent,
      failed: row.failed,
      skipped: row.skipped,
    });
    return cancelled;
  }
}
