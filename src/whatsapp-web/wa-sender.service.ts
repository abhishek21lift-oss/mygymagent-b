import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { MessageCategory } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { QueuedSend } from '../communications/interfaces/message-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { QueueConnection } from '../queue/queue.module';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { WaSessionManager } from './wa-session.manager';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between one gym's sends, plus up to jitter more: a burst
 * of identical messages at machine speed is what gets numbers restricted.
 * Constants, not env: pacing is safety equipment, not tuning. */
const MIN_GAP_MS = 8_000;
const JITTER_MS = 7_000;
const DEFAULT_DAILY_LIMIT = 200;

export interface WaSendJob {
  organizationId: string;
  messageLogId: string;
  /** Full JID (`<digits>@s.whatsapp.net`), normalized by the provider. */
  to: string;
  text: string;
  /** File id of an uploaded image; absent means text-only. */
  mediaKey?: string;
  /** Provider id to quote; unknown ids send without a quote. */
  replyToMessageId?: string;
}

/**
 * Hands WHATSAPP-channel messages to the gym's linked number.
 *
 * Nothing is sent from the request: each message becomes a job, and jobs
 * for one gym are spaced apart. Refused outright: MARKETING messages
 * (promotions are what WhatsApp bans unofficial clients for) and anything
 * past the gym's daily limit.
 */
@Injectable()
export class WaSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manager: WaSessionManager,
    private readonly queueConnection: QueueConnection,
    @InjectQueue(QUEUE_NAMES.WA_SEND) private readonly queue: Queue,
  ) {}

  async enqueue(message: {
    organizationId: string;
    to: string;
    text: string;
    messageLogId?: string;
    category?: MessageCategory;
    mediaKey?: string;
    replyToMessageId?: string;
  }): Promise<QueuedSend> {
    const { organizationId } = message;
    if (message.category === 'MARKETING') {
      throw new ForbiddenException(
        "Marketing messages can't go through the gym's WhatsApp number -- WhatsApp bans numbers for it.",
      );
    }
    if (!message.messageLogId) {
      // Every caller goes through CommunicationsService, which logs first;
      // without the row there is nothing to report the outcome on.
      throw new Error('WhatsApp sends need a MessageLog row');
    }
    if ((await this.manager.getStatus(organizationId)) !== 'CONNECTED') {
      throw new ServiceUnavailableException(
        'Your WhatsApp number is not connected. Link it again in Settings → WhatsApp.',
      );
    }
    const prefs = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { dailyLimit: true },
    });
    const dailyLimit = prefs?.dailyLimit ?? DEFAULT_DAILY_LIMIT;
    const sentToday = await this.prisma.messageLog.count({
      where: {
        organizationId,
        channel: 'WHATSAPP',
        providerMessageId: { startsWith: 'waakg:' },
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
    if (sentToday >= dailyLimit) {
      throw new HttpException(
        `Daily WhatsApp limit reached (${dailyLimit} in 24 hours). It resets as the oldest messages pass 24 hours, or raise it in Settings → WhatsApp.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const delay = await this.nextSlot(organizationId);
    const job: WaSendJob = {
      organizationId,
      messageLogId: message.messageLogId,
      to: message.to,
      text: message.text,
      ...(message.mediaKey ? { mediaKey: message.mediaKey } : {}),
      ...(message.replyToMessageId
        ? { replyToMessageId: message.replyToMessageId }
        : {}),
    };
    await this.queue.add(JOB_NAMES.SEND_WHATSAPP_WEB, job, {
      delay,
      jobId: `wa-${message.messageLogId}`,
      // Retries cover this gym's socket being on another server or briefly
      // reconnecting; the processor gives up for good on anything else.
      attempts: 8,
      backoff: { type: 'exponential', delay: 15_000 },
    });
    return {
      queued: true,
      providerMessageId: `waakg:queued:${message.messageLogId}`,
    };
  }

  /** Milliseconds from now until this gym's next free sending slot, and
   * books the slot after it -- atomically, so two requests at once cannot
   * both take the same one. */
  private async nextSlot(organizationId: string): Promise<number> {
    const gap = MIN_GAP_MS + Math.floor(Math.random() * (JITTER_MS + 1));
    const now = Date.now();
    const at = await this.queueConnection.client.eval(
      `local now = tonumber(ARGV[1])
       local gap = tonumber(ARGV[2])
       local booked = tonumber(redis.call('get', KEYS[1]) or '0')
       local at = math.max(now, booked)
       redis.call('set', KEYS[1], at + gap, 'PX', at + gap - now + 60000)
       return at`,
      1,
      `wa-send-slot:${organizationId}`,
      String(now),
      String(gap),
    );
    return Math.max(0, Number(at) - now);
  }
}
