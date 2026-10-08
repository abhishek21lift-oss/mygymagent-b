import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import type { MessageStatus } from '@prisma/client';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { sessionIdFor, WaAkgProvider } from './wa-akg.provider';
import { WhatsappInboundFiler } from './whatsapp-inbound.filer';
import type {
  SendWhatsAppMessageDto,
  TestSendWhatsAppDto,
} from './dto/whatsapp.dto';

/// The Meta webhook payload shapes below stay until the webhook receiver
/// is swapped to WA-AKG (next task) -- inbound texts and statuses still
/// arrive in Meta form.

/// WA-AKG webhook envelope (`POST /whatsapp/webhook`): the gateway fans
/// out `{ event, sessionId, timestamp, data }` per gym session, signed
/// with `X-Webhook-Signature`. Only the two events below are consumed;
/// everything else is acked and ignored.
interface WaAkgWebhookPayload {
  event?: string;
  sessionId?: string;
  timestamp?: string;
  data?: {
    key?: { id?: string; fromMe?: boolean };
    keyId?: string;
    from?: string;
    isGroup?: boolean;
    type?: string;
    content?: string;
    status?: string;
  };
}

/**
 * WhatsApp integration, served by the shared WA-AKG gateway: each gym
 * owns one WA-AKG session (`gym-{organizationId}`), linked by scanning
 * its QR, and the WHATSAPP channel sends through it.
 *
 * Outbound delivery goes through CommunicationsService's provider
 * abstraction, now backed by WaAkgProvider with the provider message id
 * stored on MessageLog; the WA-AKG status webhook advances those rows
 * SENT -> DELIVERED -> READ and files inbound texts into
 * `InboundMessage` for the CRM unmatched queue.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly communications: CommunicationsService,
    private readonly inbound: WhatsappInboundFiler,
    private readonly waAkg: WaAkgProvider,
  ) {}

  /**
   * The gym's WA-AKG session mapped onto the integration shape the
   * settings page reads -- null when the gym has no session yet, so the
   * page offers linking. Meta fields (wabaId/phoneNumberId) are gone
   * with the Cloud API and stay null.
   */
  async getIntegration(organizationId: string) {
    const session = await this.waAkg.getSession(sessionIdFor(organizationId));
    if (!session) return null;
    const now = new Date();
    return {
      id: sessionIdFor(organizationId),
      organizationId,
      status: session.status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED',
      wabaId: null,
      phoneNumberId: null,
      displayPhoneNumber: session.me?.id?.split('@')[0] ?? null,
      displayName: null,
      businessAccountId: null,
      lastError:
        session.status === 'LOGGED_OUT'
          ? 'The number was logged out from the phone -- link it again.'
          : null,
      connectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Meta embedded signup was removed with the WA-AKG replacement. Kept
   * as an explicit 410 (not a deleted route) so the old settings flow
   * fails with a message instead of a bare 404.
   */
  async completeEmbeddedSignup(): Promise<never> {
    throw new GoneException(
      'Meta WhatsApp onboarding was removed -- link the gym number through WhatsApp (WA-AKG) instead.',
    );
  }

  async disconnect(organizationId: string) {
    // Unlink the number remotely: from this point no send can succeed
    // for the org. Errors propagate -- a failed unlink must not report
    // success while the session still sends.
    await this.waAkg.performAction(sessionIdFor(organizationId), 'logout');
    return { disconnected: true, credentialRemoved: false };
  }

  listMessages(organizationId: string, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.messageLog.findMany({
      where: { organizationId, channel: 'WHATSAPP' },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Delivery log for the settings page. Same rows as listMessages under
   * the documented `/whatsapp/logs` path (listMessages predates it and
   * stays for back-compat).
   */
  listLogs(organizationId: string, limit = 50) {
    return this.listMessages(organizationId, limit);
  }

  /**
   * WhatsApp templates visible to an org: system defaults (organizationId
   * null) overlaid with org overrides, org rows winning per key.
   */
  async listTemplates(organizationId: string) {
    const rows = await this.prisma.messageTemplate.findMany({
      where: {
        channel: 'WHATSAPP',
        OR: [{ organizationId }, { organizationId: null }],
      },
      orderBy: { key: 'asc' },
    });
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const prev = byKey.get(row.key);
      if (!prev || row.organizationId !== null) byKey.set(row.key, row);
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  sendMessage(organizationId: string, dto: SendWhatsAppMessageDto) {
    if (!dto.to.trim() || !dto.text.trim())
      throw new BadRequestException('to and text are required');
    return this.communications.sendAdHoc({
      organizationId,
      channel: 'WHATSAPP',
      category: 'TRANSACTIONAL',
      recipient: dto.to.trim(),
      body: dto.text,
    });
  }

  /**
   * Frontend "send test message" button: a `welcome`-template hello through
   * the normal template pipeline (consent gating, MessageLog, provider
   * dispatch). Always resolves to the MessageLog row -- SENT with a
   * providerMessageId on success, the FAILED row on provider error -- so
   * the button can render delivery state instead of an exception shape.
   */
  async testSend(organizationId: string, dto: TestSendWhatsAppDto) {
    const to = dto.to.trim();
    if (!to) throw new BadRequestException('to is required');
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    try {
      return await this.communications.send({
        organizationId,
        channel: 'WHATSAPP',
        category: 'TRANSACTIONAL',
        templateKey: 'welcome',
        recipient: to,
        variables: { '1': 'there', '2': organization?.name ?? '' },
      });
    } catch (error) {
      // CommunicationsService already recorded the FAILED row before
      // rethrowing -- return it so the caller sees MessageLog status.
      const failed = await this.prisma.messageLog.findFirst({
        where: {
          organizationId,
          channel: 'WHATSAPP',
          templateKey: 'welcome',
          recipient: to,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (failed) return failed;
      throw error;
    }
  }

  listInbound(
    organizationId: string,
    opts: { matched?: boolean; limit?: number },
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.prisma.inboundMessage.findMany({
      where: {
        organizationId,
        ...(opts.matched === true ? { NOT: { matchedMemberId: null } } : {}),
        ...(opts.matched === false ? { matchedMemberId: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Verifies WA-AKG's `X-Webhook-Signature` (`sha256=<hex HMAC-SHA256>`
   * over the raw request bytes, keyed with WA_AKG_WEBHOOK_SECRET) before
   * any inbound payload is trusted. Without this, anyone who knows a
   * session id could forge inbound texts and delivery statuses into any
   * org's CRM queue -- the id in the payload is routing, not
   * authentication.
   *
   * Fails closed in production when the secret is unset; in
   * non-production an unset secret only warns (local dev without WA-AKG).
   */
  verifyWaAkgSignature(rawBody: Buffer, signature: string | undefined): void {
    const secret = this.config.get<string>('WA_AKG_WEBHOOK_SECRET', '');
    if (!secret) {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new ServiceUnavailableException(
          'WhatsApp webhook secret is not configured',
        );
      }
      this.logger.warn(
        'WA_AKG_WEBHOOK_SECRET is unset -- accepting unverified WhatsApp webhook payload (development only)',
      );
      return;
    }
    if (!signature || !signature.startsWith('sha256=')) {
      throw new ForbiddenException('Invalid webhook signature');
    }
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('WhatsApp webhook signature mismatch');
      throw new ForbiddenException('Invalid webhook signature');
    }
  }

  /**
   * WA-AKG event receiver. Always resolves `{ received: true }` once the
   * payload parses -- even for unknown sessions -- so the gateway stops
   * retrying a delivery that would never succeed on a later attempt.
   * `message.status` advances MessageLog by providerMessageId;
   * `message.received` texts are filed into InboundMessage + emit
   * `whatsapp.received`. Anything else is acked and ignored.
   */
  async handleWebhook(payload: unknown) {
    const body = (payload ?? {}) as WaAkgWebhookPayload;
    const organizationId = await this.resolveWaAkgOrganization(body.sessionId);
    if (!organizationId) {
      this.logger.warn(
        'WhatsApp webhook for unknown session -- acked, ignored',
      );
      return { received: true };
    }
    if (body.event === 'message.status') {
      await this.applyWaAkgStatus(organizationId, body.data);
    } else if (body.event === 'message.received') {
      await this.fileWaAkgInbound(organizationId, body.data);
    }
    return { received: true };
  }

  /** `gym-{orgId}` back to the org, verified against the database: the
   * session id in the payload is routing, not proof of origin (the HMAC
   * above is the proof), so a well-formed but unknown session still lands
   * nowhere. */
  private async resolveWaAkgOrganization(
    sessionId: string | undefined,
  ): Promise<string | null> {
    if (!sessionId || !sessionId.startsWith('gym-')) return null;
    const organizationId = sessionId.slice('gym-'.length);
    if (!organizationId) return null;
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    return organization?.id ?? null;
  }

  private async applyWaAkgStatus(
    organizationId: string,
    data: WaAkgWebhookPayload['data'],
  ) {
    const toMessageStatus: Record<string, MessageStatus> = {
      SENT: 'SENT',
      DELIVERED: 'DELIVERED',
      READ: 'READ',
    };
    const status = data?.status ? toMessageStatus[data.status] : undefined;
    if (!data?.keyId || !status) return;
    await this.prisma.messageLog.updateMany({
      where: {
        providerMessageId: `waakg:${data.keyId}`,
        organizationId,
      },
      data: { status },
    });
    this.logger.log(
      `WhatsApp status ${data.status} for org ${organizationId} (provider id waakg:${data.keyId})`,
    );
  }

  private async fileWaAkgInbound(
    organizationId: string,
    data: WaAkgWebhookPayload['data'],
  ) {
    // Only a human's direct text becomes an InboundMessage row: own-number
    // echoes, group chats, and media/reactions have no reply to file for
    // the CRM queue (same rule the old Baileys path applied).
    if (!data?.from || data.isGroup || data.key?.fromMe) return;
    if (data.type !== 'TEXT' || !data.content?.trim()) return;
    await this.inbound.file(organizationId, data.from, data.content);
  }

  private tokensEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
