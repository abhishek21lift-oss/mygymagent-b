import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MessageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappInboundFiler } from './whatsapp-inbound.filer';

// WA-AKG signs the exact POST bytes:
// `X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`.
const SIGNATURE_PREFIX = 'sha256=';
// WA-AKG stamps dispatch time as an ISO string; anything older is a replay.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
// Session ids are derived, never stored: `gym-{organizationId}`.
const SESSION_SLUG = /^gym-(.+)$/;
// A gateway receipt only moves a MessageLog row up, never back.
const PRIOR_STATES: Record<string, MessageStatus[]> = {
  SENT: ['PENDING'],
  DELIVERED: ['SENT'],
  READ: ['SENT', 'DELIVERED'],
};

/**
 * WA-AKG's outbound webhooks (`{event, sessionId, timestamp, data}`).
 * Verified by HMAC over the raw bytes, replay-guarded by timestamp, then
 * fanned into the same downstream as the socket path (shared filer, same
 * MessageLog transitions) so nothing past this file knows the gateway.
 */
@Injectable()
export class GatewayWebhookService {
  private readonly logger = new Logger(GatewayWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly filer: WhatsappInboundFiler,
  ) {}

  async handle(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ received: boolean }> {
    const secret = this.config.get<string>('WA_GATEWAY_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('Gateway webhook secret not configured');
      throw new ServiceUnavailableException('Webhook secret not configured');
    }
    if (!this.signatureValid(secret, rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let payload: { event?: string; sessionId?: string; timestamp?: unknown; data?: unknown };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed webhook payload');
    }

    const sentAt = Date.parse(payload?.timestamp as string);
    if (!Number.isFinite(sentAt)) {
      throw new BadRequestException('Missing webhook timestamp');
    }
    if (Math.abs(Date.now() - sentAt) > REPLAY_WINDOW_MS) {
      throw new UnauthorizedException('Stale webhook timestamp');
    }

    // Slug checked before any DB read, so a forged session id costs nothing.
    const slug = SESSION_SLUG.exec(
      typeof payload?.sessionId === 'string' ? payload.sessionId : '',
    );
    if (!slug) throw new NotFoundException('Unknown gateway session');
    const organizationId = slug[1];
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org) throw new NotFoundException('Unknown gateway session');

    switch (payload?.event) {
      case 'message.received':
        await this.handleReceived(organizationId, payload.data);
        break;
      case 'message.status':
        await this.handleStatus(organizationId, payload.data);
        break;
      case 'connection.update':
        await this.handleConnection(organizationId, payload.data);
        break;
      default:
        // Unknown events ack 200, never 500: there is nothing to retry.
        this.logger.log(`Ignoring gateway event ${payload?.event}`);
    }
    return { received: true };
  }

  private signatureValid(
    secret: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean {
    if (!signature?.startsWith(SIGNATURE_PREFIX)) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex');
      if (provided.length !== expected.length) return false;
      return timingSafeEqual(provided, expected);
    } catch {
      return false;
    }
  }

  // Same filing rules as the socket path (wa-session.manager onMessages):
  // skip own echoes and empty bodies, group replies go back to the group.
  private async handleReceived(organizationId: string, data: unknown) {
    const msg = (data ?? {}) as Record<string, unknown>;
    if ((msg.key as Record<string, unknown> | undefined)?.fromMe) return;
    // WA-AKG sends text in `content`, media captions in `caption`.
    const body = String(
      (msg.content as string) || (msg.caption as string) || '',
    ).trim();
    if (!body) return;
    const pushName =
      typeof msg.pushName === 'string' ? msg.pushName : null;
    const key = (msg.key ?? {}) as Record<string, unknown>;
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : null;
    if (msg.isGroup === true && remoteJid?.endsWith('@g.us')) {
      // `sender` can be an enriched participant object ({id, ...}); the raw
      // participant JID in the key is the fallback. Either way digits only.
      const sender = digits(
        typeof key.participant === 'string'
          ? key.participant
          : senderJid(msg.sender),
      );
      if (!sender) return;
      await this.filer.fileGroup(
        organizationId,
        remoteJid,
        sender,
        body,
        pushName,
      );
      return;
    }
    const from = digits(msg.from);
    if (!from) return;
    await this.filer.file(organizationId, from, body, pushName);
  }

  private async handleStatus(organizationId: string, data: unknown) {
    const msg = (data ?? {}) as Record<string, unknown>;
    const prior =
      typeof msg.status === 'string' ? PRIOR_STATES[msg.status] : undefined;
    const keyId = typeof msg.keyId === 'string' ? msg.keyId : '';
    // PENDING and unknown statuses have no prior states: zero writes.
    if (!prior || !keyId) return;
    await this.prisma.messageLog.updateMany({
      where: {
        organizationId,
        providerMessageId: `waakg-gw:${keyId}`,
        status: { in: prior },
      },
      data: { status: msg.status as MessageStatus },
    });
  }

  // Display only: the socket no longer lives here, so this never drives
  // sending. Never creates a row -- an unknown org already 404'd above.
  private async handleConnection(organizationId: string, data: unknown) {
    const msg = (data ?? {}) as Record<string, unknown>;
    const status = String(msg.status ?? '').toUpperCase();
    const mapped =
      status === 'CONNECTED'
        ? 'CONNECTED'
        : status === 'SCAN_QR'
          ? 'PAIRING'
          : status === 'LOGGED_OUT'
            ? 'LOGGED_OUT'
            : 'DISCONNECTED';
    await this.prisma.waSession.updateMany({
      where: { organizationId },
      data: {
        status: mapped,
        qr: typeof msg.qr === 'string' ? msg.qr : null,
        lastError: mapped === 'CONNECTED' ? null : undefined,
      },
    });
  }
}

function senderJid(sender: unknown): string | null {
  if (typeof sender === 'string') return sender;
  const id = (sender as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

function digits(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const only = value.replace(/\D/g, '');
  return only || null;
}
