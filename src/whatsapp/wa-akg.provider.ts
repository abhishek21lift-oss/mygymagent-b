import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MessageCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  MessageProvider,
  QueuedSend,
} from '../communications/interfaces/message-provider.interface';
import { WaSender } from '../whatsapp-web/wa-sender.service';

/** Deterministic session per gym, shared with the session module
 * (see `./wa-types`; re-exported here for callers). */
export { sessionIdFor } from '../whatsapp-web/wa-types';

const INDIA_TIMEZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);

/**
 * A phone number as a WhatsApp JID. An Indian gym's local numbers get
 * +91; any other short number is refused rather than guessed at, because
 * a wrong country code messages a stranger.
 */
export function toJid(
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
  return `${digits}@s.whatsapp.net`;
}

/**
 * The WHATSAPP channel, served by the gym's linked number in-process:
 * sends are paced jobs on the gym's live session, provider id `waakg:<id>`
 * lands on MessageLog, receipts advance it in Phase 2.
 */
@Injectable()
export class WaAkgProvider implements MessageProvider {
  private readonly logger = new Logger(WaAkgProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sender: WaSender,
  ) {}

  isConfigured(): boolean {
    return !!(this.config.get<string>('WA_AUTH_KEY', '') ?? '').trim();
  }

  async send(message: {
    to: string;
    text: string;
    organizationId?: string;
    category?: MessageCategory;
    messageLogId?: string;
    mediaKey?: string;
    replyToMessageId?: string;
    broadcastId?: string;
  }): Promise<string | QueuedSend> {
    const notConfigured = new ServiceUnavailableException(
      "WhatsApp sending isn't configured",
    );
    if (!this.isConfigured() || !message.organizationId) throw notConfigured;
    const { organizationId } = message;

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true, timezone: true },
    });
    // A missing org row degrades to non-Indian: full international numbers
    // still send, local ones fail with the country-code error below.
    // A raw JID (group chats end `@g.us`) passes through untouched --
    // phone numbers never contain `@`.
    const jid = message.to.includes('@')
      ? message.to
      : toJid(message.to, organization);
    return this.sender.enqueue({
      organizationId,
      to: jid,
      text: message.text,
      category: message.category,
      messageLogId: message.messageLogId,
      mediaKey: message.mediaKey,
      replyToMessageId: message.replyToMessageId,
      broadcastId: message.broadcastId,
    });
  }
}
