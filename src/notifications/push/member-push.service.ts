import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MEMBER_NOTIFICATION_CATEGORY_KEYS,
  type NotificationCategory,
} from '../notification-categories';
import { PushDispatchService } from './push-dispatch.service';

export interface MemberPushInput {
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** A portal route: the member's app, never a staff screen. */
  actionUrl: string;
  /** Stable per event, so a retried or re-emitted event pushes once. */
  dedupeKey: string;
  /** Whoever caused the event. A member is not pushed about something
   * they just did themselves in the portal. */
  actorUserId?: string | null;
}

/**
 * Pushes to a gym member's own devices.
 *
 * A member receives push through the same device registry as staff -- the
 * portal registers under the member's own login (`Member.userId`) -- so
 * this resolves the member to that user and hands off to
 * `PushDispatchService`, which owns preferences, devices, dedupe and the
 * queue.
 *
 * Only the member-facing categories send (the six the portal shows). A
 * preference row with `push: false` mutes that category; no row means on,
 * matching what the portal displays.
 */
@Injectable()
export class MemberPushService {
  private readonly logger = new Logger(MemberPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushDispatchService,
  ) {}

  /** Never throws: callers are event handlers and schedulers, and a push
   * is never worth failing the thing that triggered it. */
  async notifyMember(
    organizationId: string,
    memberId: string,
    input: MemberPushInput,
  ): Promise<void> {
    try {
      if (!MEMBER_NOTIFICATION_CATEGORY_KEYS.includes(input.category)) {
        throw new Error(`${input.category} is not a member-facing category`);
      }
      const member = await this.prisma.member.findFirst({
        where: { id: memberId, organizationId, deletedAt: null },
        select: { userId: true },
      });
      // No login, no devices: nothing to send, nothing wrong.
      if (!member?.userId) return;
      if (input.actorUserId && input.actorUserId === member.userId) return;

      this.push.dispatch(
        organizationId,
        [member.userId],
        {
          type: input.type,
          category: input.category,
          title: input.title,
          body: input.body,
          actionUrl: input.actionUrl,
          dedupeKey: `member:${input.dedupeKey}`,
        },
        { defaultOn: true },
      );
    } catch (error) {
      this.logger.warn(
        `Member push for ${input.type} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** "₹2,000" rather than "2000.00 INR". Falls back to the raw values for
   * a currency code Intl does not know. */
  formatAmount(amount: string, currency: string): string {
    const value = Number(amount);
    if (!Number.isFinite(value)) return `${amount} ${currency}`;
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency,
        maximumFractionDigits: value % 1 === 0 ? 0 : 2,
      }).format(value);
    } catch {
      return `${amount} ${currency}`;
    }
  }

  /** "Tue 30 Sept, 6:00 pm" in the gym's own timezone -- the time the
   * member will actually walk in, not the server's UTC. */
  async formatWhen(organizationId: string, when: Date): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    };
    try {
      return new Intl.DateTimeFormat('en-IN', {
        ...options,
        timeZone: org?.timezone || 'UTC',
      }).format(when);
    } catch {
      return new Intl.DateTimeFormat('en-IN', {
        ...options,
        timeZone: 'UTC',
      }).format(when);
    }
  }
}
