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

/// One `changes[]` value of Meta's WhatsApp webhook (`field: messages`) --
/// enough of the shape to route statuses and inbound texts, nothing more.
interface WebhookChangeValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  messages?: Array<{
    from?: string;
    id?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }>;
  statuses?: Array<{
    id?: string;
    status?: string;
    timestamp?: string;
    recipient_id?: string;
    errors?: Array<{ title?: string; message?: string }>;
  }>;
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: WebhookChangeValue }>;
  }>;
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
    const session = await this.waAkg.getSession(
      sessionIdFor(organizationId),
    );
    if (!session) return null;
    const now = new Date();
    return {
      id: sessionIdFor(organizationId),
      organizationId,
      status:
        session.status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED',
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
    await this.waAkg.performAction(
      sessionIdFor(organizationId),
      'logout',
    );
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
   * GET /whatsapp/webhook verification (Meta's hub challenge). Fails closed
   * (403, no detail) when the verify token is unset or mismatched -- the
   * comparison is constant-time so a wrong guess leaks nothing measurable.
   */
  verifyWebhook(mode?: string, verifyToken?: string, challenge?: string) {
    const expected = this.config.get<string>('META_WABA_VERIFY_TOKEN', '');
    const ok =
      mode === 'subscribe' &&
      !!challenge &&
      !!expected &&
      !!verifyToken &&
      this.tokensEqual(verifyToken, expected);
    if (!ok) {
      this.logger.warn('WhatsApp webhook verification failed');
      throw new ForbiddenException('Webhook verification failed');
    }
    return challenge;
  }

  private tokensEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  /**
   * Verifies Meta's `X-Hub-Signature-256` (`sha256=<hex HMAC-SHA256>` over
   * the raw request bytes, keyed with META_APP_SECRET) before any inbound
   * payload is trusted. Without this, anyone who knows a phone_number_id
   * could forge inbound texts and delivery statuses into any org's CRM
   * queue -- the id in the payload is routing, not authentication.
   *
   * Fails closed in production when the secret is unset; in non-production
   * an unset secret only warns (local dev without Meta credentials).
   */
  verifyInboundSignature(rawBody: Buffer, signature: string | undefined): void {
    const appSecret = this.config.get<string>('META_APP_SECRET', '');
    if (!appSecret) {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new ServiceUnavailableException(
          'WhatsApp webhook secret is not configured',
        );
      }
      this.logger.warn(
        'META_APP_SECRET is unset -- accepting unverified WhatsApp webhook payload (development only)',
      );
      return;
    }
    if (!signature || !signature.startsWith('sha256=')) {
      throw new ForbiddenException('Invalid webhook signature');
    }
    const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('WhatsApp webhook signature mismatch');
      throw new ForbiddenException('Invalid webhook signature');
    }
  }

  /**
   * POST /whatsapp/webhook receiver. Always resolves `{ received: true }`
   * once the payload parses -- even for unknown numbers/statuses -- so
   * Meta stops retrying a delivery that would never succeed on a later
   * attempt (same ack-even-if-unknown pattern as the Razorpay webhook).
   * Status callbacks advance MessageLog by providerMessageId; inbound
   * texts are filed into InboundMessage + emit `whatsapp.received`.
   */
  async handleWebhook(payload: unknown) {
    const body = (payload ?? {}) as WebhookPayload;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        const organizationId = await this.resolveOrganization(
          value.metadata?.phone_number_id,
        );
        if (!organizationId) {
          this.logger.warn(
            'WhatsApp webhook for unknown phone_number_id -- acked, ignored',
          );
          continue;
        }
        await this.applyStatuses(organizationId, value.statuses ?? []);
        await this.fileInboundTexts(organizationId, value.messages ?? []);
      }
    }
    return { received: true };
  }

  private async resolveOrganization(
    phoneNumberId: string | undefined,
  ): Promise<string | null> {
    if (!phoneNumberId) return null;
    const integration = await this.prisma.whatsappIntegration.findFirst({
      where: { phoneNumberId },
      select: { organizationId: true },
    });
    return integration?.organizationId ?? null;
  }

  private async applyStatuses(
    organizationId: string,
    statuses: NonNullable<WebhookChangeValue['statuses']>,
  ) {
    const toMessageStatus: Record<string, MessageStatus> = {
      sent: 'SENT',
      delivered: 'DELIVERED',
      read: 'READ',
      failed: 'FAILED',
    };
    for (const s of statuses) {
      const status = s.status ? toMessageStatus[s.status] : undefined;
      if (!s.id || !status) continue;
      await this.prisma.messageLog.updateMany({
        where: { providerMessageId: s.id, organizationId },
        data: {
          status,
          ...(status === 'FAILED'
            ? {
                errorMessage:
                  s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? 'failed',
              }
            : {}),
        },
      });
      this.logger.log(
        `WhatsApp status ${s.status} for org ${organizationId} (provider id ${s.id})`,
      );
    }
  }

  private async fileInboundTexts(
    organizationId: string,
    messages: NonNullable<WebhookChangeValue['messages']>,
  ) {
    for (const m of messages) {
      // Only inbound texts become InboundMessage rows (spec) -- media,
      // reactions, and echoes have no body to file for the CRM queue.
      const textBody = m.type === 'text' ? m.text?.body : undefined;
      if (!m.from || !textBody) continue;
      await this.inbound.file(organizationId, m.from, textBody);
    }
  }
}
