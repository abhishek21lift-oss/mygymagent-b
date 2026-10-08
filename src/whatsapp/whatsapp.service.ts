import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { WaSessionManager } from '../whatsapp-web/wa-session.manager';
import type {
  SendWhatsAppMessageDto,
  TestSendWhatsAppDto,
} from './dto/whatsapp.dto';

/**
 * WhatsApp integration, served in-process: each gym owns one live
 * session (`gym-{organizationId}`), linked by scanning its QR, and the
 * WHATSAPP channel sends through it.
 *
 * Outbound delivery goes through CommunicationsService's provider
 * abstraction, backed by the local sender with the provider message id
 * stored on MessageLog. Inbound texts and receipts arrive in Phase 2,
 * straight from the socket.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly manager: WaSessionManager,
  ) {}

  /**
   * The gym's live session mapped onto the integration shape the
   * settings page reads -- null when the gym has no session yet, so the
   * page offers linking.
   */
  async getIntegration(organizationId: string) {
    const [live, session] = await Promise.all([
      this.manager.getStatus(organizationId),
      this.prisma.waSession.findUnique({ where: { organizationId } }),
    ]);
    if (!session) return null;
    return {
      id: session.sessionId,
      organizationId,
      status: live === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED',
      wabaId: null,
      phoneNumberId: null,
      displayPhoneNumber: live === 'CONNECTED' ? session.phoneNumber : null,
      displayName: null,
      businessAccountId: null,
      lastError: session.lastError,
      connectedAt: session.connectedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  /**
   * Meta embedded signup was removed with the WA-AKG replacement. Kept
   * as an explicit 410 (not a deleted route) so the old settings flow
   * fails with a message instead of a bare 404.
   */
  async completeEmbeddedSignup(): Promise<never> {
    throw new GoneException(
      'Meta WhatsApp onboarding was removed -- link the gym number through WhatsApp instead.',
    );
  }

  async disconnect(organizationId: string) {
    await this.manager.disconnect(organizationId);
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

  /** 10MB -- matches FileStorageService's upload cap; a bigger File row
   * (seeded or from before the cap) is refused before queueing. */
  private static readonly MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  async sendMessage(organizationId: string, dto: SendWhatsAppMessageDto) {
    if (!dto.to.trim() || !dto.text.trim())
      throw new BadRequestException('to and text are required');
    if (dto.mediaKey)
      await this.assertSendableImage(organizationId, dto.mediaKey);
    return this.communications.sendAdHoc({
      organizationId,
      channel: 'WHATSAPP',
      category: 'TRANSACTIONAL',
      recipient: dto.to.trim(),
      body: dto.text,
      mediaKey: dto.mediaKey,
      replyToMessageId: dto.replyToMessageId,
    });
  }

  /**
   * P1 sends images only, and only the gym's own files: a File id from
   * another gym is 400 (never 404 -- existence across tenants must not
   * leak), a non-image or oversized row is 400. Runs before sendAdHoc
   * so rejections are 400, not FAILED log rows.
   */
  private async assertSendableImage(organizationId: string, mediaKey: string) {
    const file = await this.prisma.file.findFirst({
      where: { id: mediaKey, organizationId },
      select: { mimeType: true, sizeBytes: true },
    });
    if (!file)
      throw new BadRequestException(
        'mediaKey must be an uploaded file of this organization',
      );
    if (!file.mimeType.startsWith('image/'))
      throw new BadRequestException('P1 sends images only');
    if (file.sizeBytes > WhatsappService.MAX_MEDIA_BYTES)
      throw new BadRequestException('Image is too large (max 10MB)');
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
}
