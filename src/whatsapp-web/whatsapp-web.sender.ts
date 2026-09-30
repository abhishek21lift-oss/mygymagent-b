import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MessageCategory } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { QueuedSend } from '../communications/interfaces/message-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { QueueConnection } from '../queue/queue.module';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { WhatsappWebManager } from './whatsapp-web.manager';
import type { SendWhatsappWebJob } from './whatsapp-web.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hands WHATSAPP-channel messages to the gym's linked number.
 *
 * Nothing is sent from the request: each message becomes a job, and jobs
 * for one gym are spaced WHATSAPP_WEB_MIN_GAP_MS apart plus a random
 * extra of up to WHATSAPP_WEB_JITTER_MS (8-15 s by default). A burst of
 * identical messages at machine speed is the pattern most likely to get a
 * number restricted, and spacing is also simply what a person sending
 * them would do.
 *
 * Refused outright:
 *  - MARKETING messages. Promotions to many people are exactly what
 *    WhatsApp bans unofficial clients for; they belong on the official
 *    API, with templates people have opted into.
 *  - more than the gym's daily limit in any 24 hours.
 */
@Injectable()
export class WhatsappWebSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly manager: WhatsappWebManager,
    private readonly queueConnection: QueueConnection,
    @InjectQueue(QUEUE_NAMES.WHATSAPP_WEB) private readonly queue: Queue,
  ) {}

  /** Whether this gym's WhatsApp goes through its linked number. */
  async isSelected(organizationId: string): Promise<boolean> {
    if (!this.manager.enabled) return false;
    const session = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { useForSending: true },
    });
    return session?.useForSending ?? false;
  }

  async enqueue(message: {
    organizationId: string;
    to: string;
    text: string;
    messageLogId?: string;
    category?: MessageCategory;
  }): Promise<QueuedSend> {
    const { organizationId } = message;
    if (message.category === 'MARKETING') {
      throw new ForbiddenException(
        "Marketing messages can't be sent through WhatsApp Web -- WhatsApp bans numbers for it. Use the official WhatsApp API for promotions.",
      );
    }
    if (!message.messageLogId) {
      // Every caller goes through CommunicationsService, which logs first;
      // without the row there is nothing to report the outcome on.
      throw new Error('WhatsApp Web sends need a MessageLog row');
    }
    const [session, organization] = await Promise.all([
      this.prisma.whatsappWebSession.findUnique({ where: { organizationId } }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true, timezone: true },
      }),
    ]);
    if (!session || session.status !== 'CONNECTED') {
      throw new ServiceUnavailableException(
        'Your WhatsApp Web number is not connected. Link it again in Settings → WhatsApp.',
      );
    }
    const to = normaliseWhatsappNumber(message.to, organization);

    const sentToday = await this.prisma.messageLog.count({
      where: {
        organizationId,
        channel: 'WHATSAPP',
        providerMessageId: { startsWith: 'waweb:' },
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
    if (sentToday >= session.dailyLimit) {
      throw new HttpException(
        `Daily WhatsApp Web limit reached (${session.dailyLimit} in 24 hours). It resets as the oldest messages pass 24 hours, or raise it in Settings → WhatsApp.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const delay = await this.nextSlot(organizationId);
    const job: SendWhatsappWebJob = {
      organizationId,
      messageLogId: message.messageLogId,
      to,
      text: message.text,
    };
    await this.queue.add(JOB_NAMES.SEND_WHATSAPP_WEB, job, {
      delay,
      jobId: `waweb-${message.messageLogId}`,
      // Retries cover this gym's socket being on another server or briefly
      // reconnecting; the processor gives up for good on anything else.
      attempts: 8,
      backoff: { type: 'exponential', delay: 15_000 },
    });
    return {
      queued: true,
      providerMessageId: `waweb:queued:${message.messageLogId}`,
    };
  }

  /** Milliseconds from now until this gym's next free sending slot, and
   * books the slot after it -- atomically, so two requests at once cannot
   * both take the same one. */
  private async nextSlot(organizationId: string): Promise<number> {
    const minGap = Number(this.config.get('WHATSAPP_WEB_MIN_GAP_MS') ?? 8_000);
    const jitter = Number(this.config.get('WHATSAPP_WEB_JITTER_MS') ?? 7_000);
    const gap = minGap + Math.floor(Math.random() * (jitter + 1));
    const now = Date.now();
    const at = await this.queueConnection.client.eval(
      `local now = tonumber(ARGV[1])
       local gap = tonumber(ARGV[2])
       local booked = tonumber(redis.call('get', KEYS[1]) or '0')
       local at = math.max(now, booked)
       redis.call('set', KEYS[1], at + gap, 'PX', at + gap - now + 60000)
       return at`,
      1,
      this.manager.key(organizationId, 'next-slot'),
      String(now),
      String(gap),
    );
    return Math.max(0, Number(at) - now);
  }
}

const INDIA_TIMEZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);

/**
 * A member's stored phone as WhatsApp wants it: digits with the country
 * code. Numbers are often saved the Indian way -- ten digits, or with a
 * trunk 0 -- so an Indian gym's local numbers get +91; any other short
 * number is refused rather than guessed at, because a wrong country code
 * messages a stranger.
 */
export function normaliseWhatsappNumber(
  raw: string,
  organization: { currency: string; timezone: string } | null,
): string {
  const international =
    raw.trim().startsWith('+') || raw.trim().startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('00')) digits = digits.slice(2);
  const indian =
    organization?.currency === 'INR' ||
    INDIA_TIMEZONES.has(organization?.timezone ?? '');

  if (!international && indian) {
    if (digits.length === 10) digits = `91${digits}`;
    else if (digits.length === 11 && digits.startsWith('0'))
      digits = `91${digits.slice(1)}`;
  }
  if (digits.length < 11 || digits.length > 15) {
    throw new BadRequestException(
      `"${raw}" isn't a WhatsApp number we can use. Save it with the country code, e.g. +91 98765 43210.`,
    );
  }
  return digits;
}
