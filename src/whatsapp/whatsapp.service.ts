import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { timingSafeEqual } from 'crypto';
import type { MessageStatus } from '@prisma/client';
import { CommunicationsService } from '../communications/communications.service';
import {
  DomainEvent,
  type WhatsappReceivedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  encryptWhatsappToken,
  parseWhatsappVaultKey,
} from './whatsapp-token.vault';
import type {
  CompleteEmbeddedSignupDto,
  SendWhatsAppMessageDto,
  TestSendWhatsAppDto,
} from './dto/whatsapp.dto';

interface GraphPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

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
 * WhatsApp Business integration: each gym connects its OWN number via
 * Meta's embedded-signup flow (the settings page drives FB.login and
 * posts the resulting code here). The code is exchanged server-side for
 * a system-user token, which is AES-256-GCM encrypted into the
 * per-org vault row (`WhatsappCredential`) -- only integration METADATA
 * lives on `WhatsappIntegration`, and the plaintext token is never
 * logged or returned by any endpoint.
 *
 * Outbound delivery goes through CommunicationsService's provider
 * abstraction, now backed by MetaWhatsappProvider (Cloud API) with the
 * provider message id stored on MessageLog; the inbound webhook advances
 * those rows SENT -> DELIVERED -> READ and files inbound texts into
 * `InboundMessage` for the CRM unmatched queue.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly communications: CommunicationsService,
    private readonly events: EventEmitter2,
  ) {}

  getIntegration(organizationId: string) {
    // Metadata only -- the vault row (`WhatsappCredential`) is deliberately
    // never selected here or anywhere on a read path.
    return this.prisma.whatsappIntegration.findUnique({
      where: { organizationId },
    });
  }

  private metaConfig(): { appId: string; appSecret: string; version: string } {
    const appId = this.config.get<string>('META_APP_ID', '');
    const appSecret = this.config.get<string>('META_APP_SECRET', '');
    const version =
      this.config.get<string>('WHATSAPP_GRAPH_VERSION', '') || 'v25.0';
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException(
        'Meta WhatsApp onboarding is not configured yet (META_APP_ID / META_APP_SECRET)',
      );
    }
    return { appId, appSecret, version };
  }

  async completeEmbeddedSignup(
    organizationId: string,
    dto: CompleteEmbeddedSignupDto,
  ) {
    const { appId, appSecret, version } = this.metaConfig();
    // Fail before minting a token when the vault can't persist it -- the
    // 503 ("WhatsApp sending isn't configured") must surface instead of a
    // token that would exist only in this request's memory.
    const vaultKey = parseWhatsappVaultKey(
      this.config.get<string>('WHATSAPP_TOKEN_KEY', ''),
    );

    try {
      const tokenRes = await fetch(
        `https://graph.facebook.com/${version}/oauth/access_token?` +
          new URLSearchParams({
            client_id: appId,
            client_secret: appSecret,
            code: dto.code,
          }),
        { method: 'GET' },
      );
      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
      }
      const { access_token: accessToken, expires_in: expiresIn } =
        (await tokenRes.json()) as {
          access_token?: string;
          expires_in?: number;
        };
      if (!accessToken) throw new Error('Token exchange returned no token');
      const expiresAt =
        typeof expiresIn === 'number'
          ? new Date(Date.now() + expiresIn * 1000)
          : null;

      const numbersRes = await fetch(
        `https://graph.facebook.com/${version}/${dto.wabaId}/phone_numbers?` +
          new URLSearchParams({
            fields: 'id,display_phone_number,verified_name',
          }),
        {
          method: 'GET',
          // Bearer header, never a query param -- URLs end up in
          // intermediary/proxy logs, headers don't.
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!numbersRes.ok) {
        const text = await numbersRes.text();
        throw new Error(
          `Phone number lookup failed (${numbersRes.status}): ${text}`,
        );
      }
      const { data: numbers } = (await numbersRes.json()) as {
        data?: GraphPhoneNumber[];
      };
      const picked =
        (numbers ?? []).find((n) => n.id === dto.phoneNumberId) ??
        (numbers ?? [])[0] ??
        null;

      // Persist the ENCRYPTED credential first: a crash between the two
      // upserts must leave a vault row without metadata, never metadata
      // claiming CONNECTED with no way to send.
      const accessTokenEnc = encryptWhatsappToken(accessToken, vaultKey);
      await this.prisma.whatsappCredential.upsert({
        where: { organizationId },
        create: { organizationId, accessTokenEnc, expiresAt },
        update: { accessTokenEnc, expiresAt },
      });

      return this.prisma.whatsappIntegration.upsert({
        where: { organizationId },
        create: {
          organizationId,
          status: 'CONNECTED',
          wabaId: dto.wabaId,
          phoneNumberId: picked?.id ?? dto.phoneNumberId,
          displayPhoneNumber: picked?.display_phone_number,
          displayName: picked?.verified_name,
          connectedAt: new Date(),
        },
        update: {
          status: 'CONNECTED',
          wabaId: dto.wabaId,
          phoneNumberId: picked?.id ?? dto.phoneNumberId,
          displayPhoneNumber: picked?.display_phone_number,
          displayName: picked?.verified_name,
          lastError: null,
          connectedAt: new Date(),
        },
      });
    } catch (error) {
      // `accessToken` is scoped to the try block above, so it can never
      // leak into this log line or the stored lastError -- Graph error
      // bodies never contain our token either.
      const lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `WhatsApp signup failed for org ${organizationId}: ${lastError}`,
      );
      await this.prisma.whatsappIntegration.upsert({
        where: { organizationId },
        create: { organizationId, status: 'ERROR', lastError },
        update: { status: 'ERROR', lastError },
      });
      throw error instanceof ServiceUnavailableException
        ? error
        : new BadRequestException(`WhatsApp connection failed: ${lastError}`);
    }
  }

  async disconnect(organizationId: string) {
    // Delete the vault row first: from this point no send can succeed for
    // the org, even if the status update below raced a concurrent send
    // (the provider re-reads the credential on every send).
    const { count } = await this.prisma.whatsappCredential.deleteMany({
      where: { organizationId },
    });
    const existing = await this.prisma.whatsappIntegration.findUnique({
      where: { organizationId },
    });
    if (!existing) return { disconnected: true, credentialRemoved: count > 0 };
    await this.prisma.whatsappIntegration.update({
      where: { organizationId },
      data: { status: 'DISCONNECTED', lastError: null },
    });
    return { disconnected: true, credentialRemoved: count > 0 };
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
        where: { providerMessageId: s.id },
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
      const matchedMemberId = await this.matchMemberByPhone(
        organizationId,
        m.from,
      );
      const row = await this.prisma.inboundMessage.create({
        data: {
          organizationId,
          from: m.from,
          body: textBody,
          matchedMemberId,
        },
      });
      const event: WhatsappReceivedEvent = {
        organizationId,
        inboundMessageId: row.id,
        from: m.from,
        matchedMemberId,
      };
      this.events.emit(DomainEvent.WhatsappReceived, event);
    }
  }

  /**
   * Digits-suffix match: the inbound `from` is full international format
   * while a member's stored phone may be local (or vice versa), so either
   * side being a suffix of the other -- with at least 7 overlapping
   * digits -- counts as a match. Unknown numbers return null and are
   * still stored (the CRM unmatched queue reads exactly those rows).
   */
  private async matchMemberByPhone(
    organizationId: string,
    from: string,
  ): Promise<string | null> {
    const fromDigits = from.replace(/\D/g, '');
    if (fromDigits.length < 7) return null;
    const members = await this.prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const member of members) {
      if (!member.phone) continue;
      const memberDigits = member.phone.replace(/\D/g, '');
      if (memberDigits.length < 7) continue;
      if (
        fromDigits.endsWith(memberDigits) ||
        memberDigits.endsWith(fromDigits)
      ) {
        return member.id;
      }
    }
    return null;
  }
}
