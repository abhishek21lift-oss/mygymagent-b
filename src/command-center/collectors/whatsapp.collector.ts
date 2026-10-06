import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Collector, CollectorResult } from '../collectors.types';

/** One gym whose WhatsApp link needs a human. */
export interface WhatsappAttentionRow {
  organizationId: string;
  organizationName: string;
  channel: 'cloud-api' | 'web';
  status: string;
  /** Provider error text, truncated. Null when the provider gave none. */
  lastError: string | null;
  /** When the link last changed state, as best the row records it. */
  since: string;
}

export interface WhatsappCard {
  /** Gyms with at least one working link (Cloud API or linked number). */
  connectedGyms: number;
  /** Meta WhatsApp Cloud API integrations, by state. */
  cloudApi: {
    connected: number;
    disconnected: number;
    error: number;
    notConnected: number;
    /** Stored access tokens expiring within 7 days. */
    tokensExpiringSoon: number;
  };
  /** Linked phone numbers (WhatsApp Web), by state. */
  web: {
    connected: number;
    pairing: number;
    loggedOut: number;
    disconnected: number;
    /** Connected AND chosen as the gym's sending channel. */
    sendingEnabled: number;
  };
  /** Outbound WhatsApp messages created in the window, by delivery state. */
  messages: {
    pending: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    total: number;
    /** failed / settled (everything but pending). Null with nothing settled. */
    failureRate: number | null;
  };
  /** Member replies received in the window. */
  inbound: { received: number; matchedToMember: number };
  windowMs: number;
  /** Gyms whose link is broken, worst first, capped. */
  attention: WhatsappAttentionRow[];
}

const ATTENTION_LIMIT = 8;
const ERROR_TEXT_LIMIT = 160;
/** Below this many settled sends a failure rate is noise, not a signal. */
const MIN_SETTLED_FOR_RATE_ALERT = 5;
const FAILURE_RATE_ALERT = 0.1;

/**
 * Platform-wide WhatsApp health: which gyms are connected, how outbound
 * messages are faring, and which links have broken.
 *
 * Reads only what the two WhatsApp paths already record --
 * WhatsappIntegration (Cloud API), WhatsappWebSession (linked number),
 * MessageLog (outbound, channel WHATSAPP) and InboundMessage (replies). No
 * new table, no provider call: this card must stay readable while Meta is
 * down, because that is exactly when someone opens it.
 *
 * Delivery receipts (DELIVERED/READ) exist only for Cloud API sends; a
 * linked-number send stops at SENT. The card therefore reports a failure
 * rate, never a "delivery rate" that would undercount every Baileys gym.
 */
@Injectable()
export class WhatsappCollector implements Collector<WhatsappCard> {
  readonly name = 'whatsapp';
  readonly timeoutMs = 5_000;
  readonly windowMs = 24 * 60 * 60 * 1_000;

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<CollectorResult<WhatsappCard>> {
    const since = new Date(Date.now() - this.windowMs);
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);

    const [
      cloudByStatus,
      webByStatus,
      sendingEnabled,
      expiringTokens,
      messagesByStatus,
      inboundTotal,
      inboundMatched,
      cloudConnectedOrgs,
      webConnectedOrgs,
      brokenCloud,
      brokenWeb,
    ] = await Promise.all([
      this.prisma.whatsappIntegration.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.whatsappWebSession.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.whatsappWebSession.count({
        where: { status: 'CONNECTED', useForSending: true },
      }),
      this.prisma.whatsappCredential.count({
        where: { expiresAt: { not: null, lte: soon } },
      }),
      this.prisma.messageLog.groupBy({
        by: ['status'],
        where: { channel: 'WHATSAPP', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.inboundMessage.count({
        where: { createdAt: { gte: since } },
      }),
      this.prisma.inboundMessage.count({
        where: { createdAt: { gte: since }, matchedMemberId: { not: null } },
      }),
      this.prisma.whatsappIntegration.findMany({
        where: { status: 'CONNECTED' },
        select: { organizationId: true },
      }),
      this.prisma.whatsappWebSession.findMany({
        where: { status: 'CONNECTED' },
        select: { organizationId: true },
      }),
      this.prisma.whatsappIntegration.findMany({
        where: { status: { in: ['ERROR', 'DISCONNECTED'] } },
        orderBy: { updatedAt: 'desc' },
        take: ATTENTION_LIMIT,
        select: {
          organizationId: true,
          status: true,
          lastError: true,
          updatedAt: true,
          organization: { select: { name: true } },
        },
      }),
      this.prisma.whatsappWebSession.findMany({
        where: { status: 'LOGGED_OUT' },
        orderBy: { updatedAt: 'desc' },
        take: ATTENTION_LIMIT,
        select: {
          organizationId: true,
          status: true,
          lastError: true,
          disconnectedAt: true,
          updatedAt: true,
          organization: { select: { name: true } },
        },
      }),
    ]);

    const cloud = (status: string) =>
      cloudByStatus.find((row) => row.status === status)?._count._all ?? 0;
    const web = (status: string) =>
      webByStatus.find((row) => row.status === status)?._count._all ?? 0;
    const msg = (status: string) =>
      messagesByStatus.find((row) => row.status === status)?._count._all ?? 0;

    const messages = {
      pending: msg('PENDING'),
      sent: msg('SENT'),
      delivered: msg('DELIVERED'),
      read: msg('READ'),
      failed: msg('FAILED'),
      total: messagesByStatus.reduce((sum, row) => sum + row._count._all, 0),
      failureRate: null as number | null,
    };
    const settled = messages.total - messages.pending;
    messages.failureRate = settled > 0 ? messages.failed / settled : null;

    const attention: WhatsappAttentionRow[] = [
      ...brokenCloud.map((row) => ({
        organizationId: row.organizationId,
        organizationName: row.organization.name,
        channel: 'cloud-api' as const,
        status: row.status,
        lastError: truncate(row.lastError),
        since: row.updatedAt.toISOString(),
      })),
      ...brokenWeb.map((row) => ({
        organizationId: row.organizationId,
        organizationName: row.organization.name,
        channel: 'web' as const,
        status: row.status,
        lastError: truncate(row.lastError),
        since: (row.disconnectedAt ?? row.updatedAt).toISOString(),
      })),
    ]
      // A hard error outranks a plain disconnect; then most recent first.
      .sort(
        (a, b) =>
          severity(b.status) - severity(a.status) ||
          b.since.localeCompare(a.since),
      )
      .slice(0, ATTENTION_LIMIT);

    const connectedGyms = new Set([
      ...cloudConnectedOrgs.map((row) => row.organizationId),
      ...webConnectedOrgs.map((row) => row.organizationId),
    ]).size;

    const failingSends =
      messages.failureRate !== null &&
      settled >= MIN_SETTLED_FOR_RATE_ALERT &&
      messages.failureRate > FAILURE_RATE_ALERT;
    const brokenLinks = cloud('ERROR') + web('LOGGED_OUT') > 0;

    return {
      status: failingSends || brokenLinks ? 'degraded' : 'ok',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: {
        connectedGyms,
        cloudApi: {
          connected: cloud('CONNECTED'),
          disconnected: cloud('DISCONNECTED'),
          error: cloud('ERROR'),
          notConnected: cloud('NOT_CONNECTED'),
          tokensExpiringSoon: expiringTokens,
        },
        web: {
          connected: web('CONNECTED'),
          pairing: web('PAIRING'),
          loggedOut: web('LOGGED_OUT'),
          disconnected: web('DISCONNECTED'),
          sendingEnabled,
        },
        messages,
        inbound: { received: inboundTotal, matchedToMember: inboundMatched },
        windowMs: this.windowMs,
        attention,
      },
    };
  }
}

function severity(status: string): number {
  return status === 'ERROR' || status === 'LOGGED_OUT' ? 2 : 1;
}

function truncate(text: string | null): string | null {
  if (!text) return null;
  return text.length > ERROR_TEXT_LIMIT
    ? `${text.slice(0, ERROR_TEXT_LIMIT - 1)}…`
    : text;
}
