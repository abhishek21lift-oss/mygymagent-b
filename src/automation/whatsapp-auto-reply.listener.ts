import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { CommunicationsService } from '../communications/communications.service';
import {
  DomainEvent,
  type WhatsappReceivedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  readableDate,
  readableMoney,
  runningOrganization,
} from './automation-scope';
import { parseOpeningHours, readableWeek } from '../branches/opening-hours';
import {
  type AutoReplyIntent,
  detectIntent,
  readableDuration,
} from './whatsapp-auto-reply.intents';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Most automatic answers one number gets in an hour: a loop with another
 * bot, or someone testing every keyword, stops here. */
const MAX_REPLIES_PER_HOUR = 6;
/** The same answer is not sent twice this close together ("Membership",
 * then "Memberships" a minute later). */
const SAME_ANSWER_GAP_MS = 2 * MINUTE_MS;
/** "Our team will reply" is said once in this long, not to every message. */
const HOLDING_REPLY_GAP_MS = 12 * HOUR_MS;
/** A message nobody's keywords match is left to staff while they are
 * chatting with that person. */
const STAFF_ACTIVE_MS = 30 * MINUTE_MS;
const LIST_LIMIT = 10;

interface Gym {
  id: string;
  name: string;
  timezone: string;
  currency: string;
}

/**
 * Answers a member's WhatsApp message on its own, from the gym's own data:
 * membership plans and prices, this week's classes, the member's own
 * membership, and where the gym is.
 *
 * The welcome message tells members to "reply to this chat for help with
 * classes, schedules and memberships"; before this, a reply reached the
 * inbox and nobody answered it until staff happened to look.
 *
 * Only through the gym's own linked number (WhatsApp Web), and only while
 * the gym has auto-replies on. Every reply is logged like any other
 * message (`auto_reply.<intent>`), and staff still see every inbound text.
 */
@Injectable()
export class WhatsappAutoReplyListener {
  private readonly logger = new Logger(WhatsappAutoReplyListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(DomainEvent.WhatsappReceived, { async: true })
  async handle(event: WhatsappReceivedEvent): Promise<void> {
    try {
      const intent = await this.reply(event);
      if (intent) {
        this.logger.log(
          `Auto-replied ${intent} to ${event.from} (org ${event.organizationId})`,
        );
      }
    } catch (error) {
      // A reply that could not go out must never disturb filing the
      // message itself; staff still see it in the inbox.
      this.logger.warn(
        `Auto-reply for ${event.inboundMessageId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Sends the answer, and returns what was answered (null: nothing sent). */
  async reply(event: WhatsappReceivedEvent): Promise<AutoReplyIntent | null> {
    const { organizationId, from } = event;
    if (!(await this.enabled(organizationId))) return null;

    const [message, gym] = await Promise.all([
      this.prisma.inboundMessage.findUnique({
        where: { id: event.inboundMessageId },
        select: { body: true },
      }),
      this.prisma.organization.findFirst({
        where: { id: organizationId, ...runningOrganization },
        select: { id: true, name: true, timezone: true, currency: true },
      }),
    ]);
    if (!message || !gym) return null;

    const intent = detectIntent(message.body);
    // "Thanks" / "ok" ends a conversation; answering it starts another.
    if (intent === 'THANKS') return null;
    const templateKey = `auto_reply.${intent.toLowerCase()}`;

    const now = Date.now();
    const recent = await this.prisma.messageLog.findMany({
      where: {
        organizationId,
        channel: 'WHATSAPP',
        recipient: from,
        templateKey: { startsWith: 'auto_reply.' },
        createdAt: { gte: new Date(now - HOLDING_REPLY_GAP_MS) },
      },
      select: { templateKey: true, createdAt: true },
    });
    const inLastHour = recent.filter(
      (log) => log.createdAt.getTime() >= now - HOUR_MS,
    );
    if (inLastHour.length >= MAX_REPLIES_PER_HOUR) return null;
    const sameAnswerJustSent = recent.some(
      (log) =>
        log.templateKey === templateKey &&
        log.createdAt.getTime() >= now - SAME_ANSWER_GAP_MS,
    );
    if (sameAnswerJustSent) return null;

    if (intent === 'UNKNOWN') {
      if (recent.some((log) => log.templateKey === templateKey)) return null;
      if (await this.staffChatting(organizationId, from, event.matchedMemberId))
        return null;
    }

    const member = event.matchedMemberId
      ? await this.prisma.member.findFirst({
          where: { id: event.matchedMemberId, organizationId, deletedAt: null },
          select: { id: true, firstName: true },
        })
      : null;

    const body = await this.compose(intent, gym, member);
    if (!body) return null;

    await this.communications.sendAdHoc({
      organizationId,
      channel: 'WHATSAPP',
      category: 'TRANSACTIONAL',
      recipient: from,
      memberId: member?.id,
      body,
      templateKey,
      fromOwnNumber: true,
    });
    return intent;
  }

  private async enabled(organizationId: string): Promise<boolean> {
    // Only a linked number: the reply has to come from the number the
    // member wrote to. Not tied to "send reminders from this number" --
    // a gym that keeps reminders on the official API still answers chats.
    if (!(await this.communications.ownWhatsappNumberLinked(organizationId)))
      return false;
    const session = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { autoReply: true },
    });
    return session?.autoReply ?? false;
  }

  /** Whether staff wrote to this person from the app in the last half hour. */
  private async staffChatting(
    organizationId: string,
    from: string,
    memberId: string | null,
  ): Promise<boolean> {
    const staffMessage = await this.prisma.messageLog.findFirst({
      where: {
        organizationId,
        channel: 'WHATSAPP',
        templateKey: 'ad_hoc',
        createdAt: { gte: new Date(Date.now() - STAFF_ACTIVE_MS) },
        OR: [{ recipient: from }, ...(memberId ? [{ memberId }] : [])],
      },
      select: { id: true },
    });
    return staffMessage !== null;
  }

  private compose(
    intent: AutoReplyIntent,
    gym: Gym,
    member: { id: string; firstName: string } | null,
  ): Promise<string | null> | string | null {
    switch (intent) {
      case 'PLANS':
        return this.plans(gym);
      case 'CLASSES':
        return this.classes(gym);
      case 'MY_PLAN':
        return this.myPlan(gym, member);
      case 'CONTACT':
        return this.contact(gym);
      case 'HOURS':
        return this.hours(gym);
      case 'MENU':
        return this.menu(gym, member);
      case 'UNKNOWN':
        return [
          `Thanks for your message! The ${gym.name} team will reply soon.`,
          '',
          'Meanwhile, reply *PLANS*, *TIMINGS*, *CLASSES* or *MY PLAN* for an instant answer.',
        ].join('\n');
      default:
        return null;
    }
  }

  private menu(gym: Gym, member: { firstName: string } | null): string {
    return [
      `Hi${member ? ` ${member.firstName}` : ''}! Welcome to ${gym.name}.`,
      '',
      'Reply with:',
      '• *PLANS* – membership plans and prices',
      '• *TIMINGS* – when the gym is open',
      '• *CLASSES* – this week’s class schedule',
      '• *MY PLAN* – your membership and renewal',
      '• *CONTACT* – address, directions and phone',
      '',
      'Or just type your question and our team will reply.',
    ].join('\n');
  }

  private async plans(gym: Gym): Promise<string> {
    const plans = await this.prisma.membershipPlan.findMany({
      where: { organizationId: gym.id, isActive: true },
      orderBy: [{ durationDays: 'asc' }, { price: 'asc' }],
      take: LIST_LIMIT,
      select: { name: true, price: true, currency: true, durationDays: true },
    });
    if (plans.length === 0) {
      return `Thanks for asking! The ${gym.name} team will share our membership plans and prices with you shortly.`;
    }
    const lines = plans.map(
      (plan) =>
        `• ${plan.name} – ${readableMoney(Number(plan.price), plan.currency || gym.currency)} for ${readableDuration(plan.durationDays)}`,
    );
    return [
      `*${gym.name} membership plans*`,
      ...lines,
      '',
      'To join or renew, visit us at the front desk or reply here and our team will help.',
    ].join('\n');
  }

  private async classes(gym: Gym): Promise<string> {
    const now = new Date();
    const sessions = await this.prisma.classSession.findMany({
      where: {
        organizationId: gym.id,
        status: 'ACTIVE',
        startTime: { gte: now, lte: new Date(now.getTime() + 7 * DAY_MS) },
        classProgram: { status: 'ACTIVE' },
      },
      orderBy: { startTime: 'asc' },
      take: LIST_LIMIT,
      select: {
        startTime: true,
        classProgram: { select: { name: true } },
        branch: { select: { name: true, timezone: true } },
      },
    });
    if (sessions.length === 0) {
      return `There are no classes on the ${gym.name} schedule for the next 7 days. Our team will let you know when new ones open.`;
    }
    const branches = new Set(sessions.map((s) => s.branch.name));
    const lines = sessions.map((session) => {
      const when = readableSlot(
        session.startTime,
        session.branch.timezone || gym.timezone,
      );
      const where = branches.size > 1 ? ` (${session.branch.name})` : '';
      return `• ${when} – ${session.classProgram.name}${where}`;
    });
    return [
      `*${gym.name} classes this week*`,
      ...lines,
      '',
      'Book from the member app, or reply here to reserve a spot.',
    ].join('\n');
  }

  private async myPlan(
    gym: Gym,
    member: { id: string; firstName: string } | null,
  ): Promise<string> {
    if (!member) {
      return `We couldn't find a ${gym.name} membership for this number. If you joined with a different number, message us from that one — or reply *PLANS* to see our plans.`;
    }
    const membership = await this.prisma.membership.findFirst({
      where: {
        organizationId: gym.id,
        memberId: member.id,
        status: { in: ['ACTIVE', 'FROZEN'] },
      },
      orderBy: { endDate: 'desc' },
      select: {
        status: true,
        endDate: true,
        membershipPlan: { select: { name: true } },
      },
    });
    const renewLink = `${this.config.get<string>('FRONTEND_URL', 'http://localhost:3000')}/portal/renew`;
    if (!membership) {
      return [
        `Hi ${member.firstName}, you don't have an active ${gym.name} membership right now.`,
        '',
        `Renew here: ${renewLink}`,
        'Or reply *PLANS* to see our plans.',
      ].join('\n');
    }
    const until = readableDate(membership.endDate, gym.timezone);
    const daysLeft = Math.max(
      0,
      Math.ceil((membership.endDate.getTime() - Date.now()) / DAY_MS),
    );
    const state =
      membership.status === 'FROZEN'
        ? `is frozen, and runs until ${until}`
        : `is active until ${until} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left)`;
    return [
      `Hi ${member.firstName}, your ${membership.membershipPlan.name} membership ${state}.`,
      '',
      `Renew any time: ${renewLink}`,
    ].join('\n');
  }

  private async contact(gym: Gym): Promise<string> {
    const [branches, organization] = await Promise.all([
      this.activeBranches(gym),
      this.prisma.organization.findUnique({
        where: { id: gym.id },
        select: { contactPhone: true, contactEmail: true },
      }),
    ]);
    const lines = branches.flatMap((branch) => {
      const address = [branch.addressLine1, branch.addressLine2, branch.city]
        .filter(Boolean)
        .join(', ');
      const parts = [address, branch.phone].filter(Boolean);
      if (parts.length === 0 && !branch.mapsUrl) return [];
      return [
        `• ${branch.name}${parts.length ? ` – ${parts.join(' · ')}` : ''}`,
        ...(branch.mapsUrl ? [`  Directions: ${branch.mapsUrl}`] : []),
      ];
    });
    // The gym's own number and email, for a gym whose branches have none.
    const reach = [organization?.contactPhone, organization?.contactEmail]
      .filter(Boolean)
      .join(' · ');
    if (lines.length === 0 && !reach) {
      return `Thanks for asking! The ${gym.name} team will share our address and phone number with you shortly.`;
    }
    return [
      `*${gym.name}*`,
      ...lines,
      ...(reach && !branches.some((b) => b.phone)
        ? [`Call or write: ${reach}`]
        : []),
    ].join('\n');
  }

  private async hours(gym: Gym): Promise<string> {
    const branches = (await this.activeBranches(gym))
      .map((branch) => ({
        name: branch.name,
        week: readableWeek(parseOpeningHours(branch.openingHours)),
      }))
      .filter((branch) => branch.week.length > 0);
    if (branches.length === 0) {
      return `Thanks for asking! The ${gym.name} team will share our timings with you shortly.`;
    }
    if (branches.length === 1) {
      return [`*${gym.name} timings*`, ...branches[0].week].join('\n');
    }
    return [
      `*${gym.name} timings*`,
      ...branches.flatMap((branch) => ['', `*${branch.name}*`, ...branch.week]),
    ].join('\n');
  }

  private activeBranches(gym: Gym) {
    return this.prisma.branch.findMany({
      where: { organizationId: gym.id, deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      take: LIST_LIMIT,
      select: {
        name: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        mapsUrl: true,
        openingHours: true,
      },
    });
  }
}

/** "Mon 5 Oct, 7:00 am" in the branch's own timezone. */
function readableSlot(date: Date, timezone: string): string {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(date);
  try {
    return format(timezone);
  } catch {
    return format('UTC');
  }
}
