import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Collector, CollectorResult } from '../collectors.types';

export interface ChannelCounts {
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  total: number;
  /** failed / settled (everything but pending). Null with nothing settled. */
  failureRate: number | null;
}

export type MessagingChannel = 'EMAIL' | 'WHATSAPP' | 'SMS' | 'PUSH';

export interface MessagingCard {
  /** Every channel is always present, so a silent channel reads as 0
   * measured messages rather than as a missing key. */
  channels: Record<MessagingChannel, ChannelCounts>;
  totals: ChannelCounts;
  windowMs: number;
}

const CHANNELS: readonly MessagingChannel[] = [
  'EMAIL',
  'WHATSAPP',
  'SMS',
  'PUSH',
];
const MIN_SETTLED_FOR_RATE_ALERT = 5;
const FAILURE_RATE_ALERT = 0.1;

/**
 * Outbound delivery across every channel, from MessageLog -- the one table
 * every provider (SMTP, WhatsApp Cloud API, linked number, FCM) writes its
 * outcome to. Answers "are messages to members getting out", which no
 * queue-depth figure can: a job can complete and the provider still refuse
 * the message.
 */
@Injectable()
export class MessagingCollector implements Collector<MessagingCard> {
  readonly name = 'messaging';
  readonly timeoutMs = 5_000;
  readonly windowMs = 24 * 60 * 60 * 1_000;

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<CollectorResult<MessagingCard>> {
    const rows = await this.prisma.messageLog.groupBy({
      by: ['channel', 'status'],
      where: { createdAt: { gte: new Date(Date.now() - this.windowMs) } },
      _count: { _all: true },
    });

    const channels = Object.fromEntries(
      CHANNELS.map((channel) => [
        channel,
        counts(rows.filter((row) => row.channel === channel)),
      ]),
    ) as Record<MessagingChannel, ChannelCounts>;
    const totals = counts(rows);

    const failing = CHANNELS.some((channel) => {
      const c = channels[channel];
      return (
        c.failureRate !== null &&
        c.total - c.pending >= MIN_SETTLED_FOR_RATE_ALERT &&
        c.failureRate > FAILURE_RATE_ALERT
      );
    });

    return {
      status: failing ? 'degraded' : 'ok',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: { channels, totals, windowMs: this.windowMs },
    };
  }
}

function counts(
  rows: { status: string; _count: { _all: number } }[],
): ChannelCounts {
  const of = (status: string) =>
    rows
      .filter((row) => row.status === status)
      .reduce((sum, row) => sum + row._count._all, 0);
  const total = rows.reduce((sum, row) => sum + row._count._all, 0);
  const pending = of('PENDING');
  const failed = of('FAILED');
  const settled = total - pending;
  return {
    pending,
    sent: of('SENT'),
    delivered: of('DELIVERED'),
    read: of('READ'),
    failed,
    total,
    failureRate: settled > 0 ? failed / settled : null,
  };
}
