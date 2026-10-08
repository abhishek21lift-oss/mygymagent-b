import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CommunicationsService } from '../communications/communications.service';
import {
  DomainEvent,
  type WhatsappReceivedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  matchRule,
  parseBotCommand,
  type StaffRule,
} from './staff-reply.matcher';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Shared with the gym-intent listener: one number's automatic answers. */
const MAX_REPLIES_PER_HOUR = 10;
const SAME_ANSWER_GAP_MS = 2 * MINUTE_MS;

const HELP_TEXT = [
  '*WhatsApp help*',
  '• `#stop` – stop automatic replies to this number',
  '• `#start` – turn them back on',
  '• Or just type your question and our team will reply.',
].join('\n');

/**
 * Staff-written replies, ahead of the gym's own intents: `#help`,
 * `#stop`/`#start`, then keyword rules (EXACT → CONTAINS → REGEX).
 * Anything unmatched returns null so the gym-intent listener answers.
 */
@Injectable()
export class StaffReplyListener {
  private readonly logger = new Logger(StaffReplyListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
  ) {}

  @OnEvent(DomainEvent.WhatsappReceived, { async: true })
  async handle(event: WhatsappReceivedEvent): Promise<void> {
    try {
      await this.reply(event);
    } catch (error) {
      this.logger.warn(
        `Staff reply for ${event.inboundMessageId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async reply(event: WhatsappReceivedEvent): Promise<'bot' | 'rule' | null> {
    const { organizationId } = event;
    if (!(await this.enabled(organizationId))) return null;
    const message = await this.prisma.inboundMessage.findUnique({
      where: { id: event.inboundMessageId },
      select: { body: true },
    });
    if (!message) return null;
    const isGroup = event.isGroup ?? false;
    const to = isGroup ? (event.groupJid ?? event.from) : event.from;
    const phone = event.from.replace(/\D/g, '');

    const command = parseBotCommand(message.body);
    if (command === 'stop') {
      await this.prisma.botOptOut.upsert({
        where: {
          organizationId_phone: { organizationId, phone },
        },
        create: { organizationId, phone },
        update: {},
      });
      await this.send(
        event,
        to,
        'Automatic replies are off for this number. Reply `#start` any time to turn them back on.',
        'auto_reply.bot',
        event.matchedMemberId,
      );
      return 'bot';
    }
    if (command === 'start') {
      await this.prisma.botOptOut
        .delete({ where: { organizationId_phone: { organizationId, phone } } })
        .catch(() => undefined);
      await this.send(
        event,
        to,
        'Automatic replies are back on. Reply `#help` to see what I understand.',
        'auto_reply.bot',
        event.matchedMemberId,
      );
      return 'bot';
    }
    if (
      await this.prisma.botOptOut.findUnique({
        where: { organizationId_phone: { organizationId, phone } },
        select: { phone: true },
      })
    ) {
      return null;
    }
    if (command === 'help') {
      await this.send(
        event,
        to,
        HELP_TEXT,
        'auto_reply.bot',
        event.matchedMemberId,
      );
      return 'bot';
    }

    const rows = await this.prisma.autoReplyRule.findMany({
      where: { organizationId, enabled: true },
      orderBy: { priority: 'asc' },
      take: 100,
    });
    const hit = matchRule(rows as StaffRule[], message.body, isGroup);
    if (!hit) return null;
    if (await this.recentlyAnswered(organizationId, to, 'auto_reply.rule')) {
      return null;
    }
    await this.send(
      event,
      to,
      hit.answer,
      'auto_reply.rule',
      event.matchedMemberId,
    );
    return 'rule';
  }

  private async enabled(organizationId: string): Promise<boolean> {
    if (!(await this.communications.ownWhatsappNumberLinked(organizationId))) {
      return false;
    }
    const session = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { autoReply: true },
    });
    return session?.autoReply ?? false;
  }

  /** Shared hourly budget with the gym intents (`auto_reply.%` pool). */
  private async recentlyAnswered(
    organizationId: string,
    to: string,
    templateKey: string,
  ): Promise<boolean> {
    const now = Date.now();
    const recent = await this.prisma.messageLog.findMany({
      where: {
        organizationId,
        channel: 'WHATSAPP',
        recipient: to,
        templateKey: { startsWith: 'auto_reply.' },
        createdAt: { gte: new Date(now - HOUR_MS) },
      },
      select: { templateKey: true, createdAt: true },
    });
    if (recent.length >= MAX_REPLIES_PER_HOUR) return true;
    return recent.some(
      (log) =>
        log.templateKey === templateKey &&
        log.createdAt.getTime() >= now - SAME_ANSWER_GAP_MS,
    );
  }

  private send(
    event: WhatsappReceivedEvent,
    to: string,
    body: string,
    templateKey: string,
    memberId: string | null,
  ) {
    return this.communications.sendAdHoc({
      organizationId: event.organizationId,
      channel: 'WHATSAPP',
      category: 'TRANSACTIONAL',
      recipient: to,
      memberId: memberId ?? undefined,
      body,
      templateKey,
      fromOwnNumber: true,
    });
  }
}
