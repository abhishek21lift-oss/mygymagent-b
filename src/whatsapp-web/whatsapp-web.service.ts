import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { sessionIdFor, WaAkgProvider } from '../whatsapp/wa-akg.provider';
import type {
  ConnectWhatsappWebDto,
  UpdateWhatsappWebSettingsDto,
} from './dto/whatsapp-web.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

const PREF_DEFAULTS = {
  status: 'DISCONNECTED',
  phoneNumber: null,
  useForSending: false,
  autoReply: true,
  dailyLimit: 200,
  riskAcceptedAt: null,
  connectedAt: null,
  lastError: null,
};

/**
 * A gym's own WhatsApp number, linked by scanning its QR -- served by
 * the shared WA-AKG gateway (one session per gym) instead of the
 * removed in-process Baileys stack.
 *
 * Liveness (status, number, QR, pairing code) is read from WA-AKG on
 * every call; only the gym's sending *preferences* (auto-reply, daily
 * limit) stay in the local row, which is also what the auto-reply
 * listener reads.
 */
@Injectable()
export class WhatsappWebService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly waAkg: WaAkgProvider,
  ) {}

  /**
   * Whether this deployment can run WhatsApp: WA-AKG configured, or the
   * DISABLED reason the settings page names.
   */
  availability():
    | { available: true; unavailableReason: null }
    | { available: false; unavailableReason: 'DISABLED' } {
    if (!this.waAkg.isConfigured()) {
      return { available: false, unavailableReason: 'DISABLED' };
    }
    return { available: true, unavailableReason: null };
  }

  available(): boolean {
    return this.availability().available;
  }

  async status(organizationId: string) {
    const [prefs, session, sentLast24h] = await Promise.all([
      this.prisma.whatsappWebSession.findUnique({
        where: { organizationId },
      }),
      this.waAkg.getSession(sessionIdFor(organizationId)),
      this.prisma.messageLog.count({
        where: {
          organizationId,
          channel: 'WHATSAPP',
          providerMessageId: { startsWith: 'waakg:' },
          createdAt: { gte: new Date(Date.now() - DAY_MS) },
        },
      }),
    ]);
    return {
      ...this.availability(),
      ...(prefs ?? PREF_DEFAULTS),
      sentLast24h,
      ...(await this.liveness(session)),
    };
  }

  /** WA-AKG live status onto the settings-page shape. */
  private async liveness(
    session: Awaited<ReturnType<WaAkgProvider['getSession']>>,
  ) {
    if (!session) {
      return {
        status: 'DISCONNECTED',
        phoneNumber: null,
        connectedAt: null,
        lastError: null,
        qrDataUrl: null,
        pairingCode: null,
      };
    }
    if (session.status === 'CONNECTED') {
      return {
        status: 'CONNECTED' as const,
        phoneNumber: session.me?.id?.split('@')[0] ?? null,
        connectedAt: new Date(),
        lastError: null,
        qrDataUrl: null,
        pairingCode: null,
      };
    }
    if (session.status === 'LOGGED_OUT') {
      return {
        status: 'LOGGED_OUT' as const,
        phoneNumber: null,
        connectedAt: null,
        lastError:
          'The number was logged out from the phone -- link it again.',
        qrDataUrl: null,
        pairingCode: null,
      };
    }
    if (session.status === 'SCAN_QR') {
      let qrDataUrl: string | null = null;
      if (session.qr) {
        try {
          qrDataUrl = await QRCode.toDataURL(session.qr);
        } catch {
          qrDataUrl = null;
        }
      }
      return {
        status: 'PAIRING' as const,
        phoneNumber: null,
        connectedAt: null,
        lastError: null,
        qrDataUrl,
        pairingCode: session.pairingCode ?? null,
      };
    }
    return {
      status: 'DISCONNECTED',
      phoneNumber: null,
      connectedAt: null,
      lastError: null,
      qrDataUrl: null,
      pairingCode: null,
    };
  }

  async connect(
    organizationId: string,
    userId: string,
    dto: ConnectWhatsappWebDto,
  ) {
    if (!this.available()) {
      throw new ServiceUnavailableException(
        "WhatsApp isn't available on this deployment.",
      );
    }
    const live = await this.waAkg.getSession(
      sessionIdFor(organizationId),
    );
    if (live?.status === 'CONNECTED') {
      throw new ConflictException(
        'A number is already linked. Unlink it first to link a different one.',
      );
    }
    await this.waAkg.ensureSession(sessionIdFor(organizationId));
    await this.waAkg.performAction(sessionIdFor(organizationId), 'start');
    await this.prisma.whatsappWebSession.upsert({
      where: { organizationId },
      create: {
        organizationId,
        status: 'PAIRING',
        riskAcceptedAt: new Date(),
        riskAcceptedByUserId: userId,
      },
      update: {
        status: 'PAIRING',
        riskAcceptedAt: new Date(),
        riskAcceptedByUserId: userId,
        lastError: null,
      },
    });
    return this.status(organizationId);
  }

  async disconnect(organizationId: string) {
    await this.waAkg.performAction(sessionIdFor(organizationId), 'logout');
    await this.prisma.whatsappWebSession.updateMany({
      where: { organizationId },
      data: {
        status: 'DISCONNECTED',
        phoneNumber: null,
        useForSending: false,
        disconnectedAt: new Date(),
        lastError: null,
      },
    });
    return this.status(organizationId);
  }

  async updateSettings(
    organizationId: string,
    dto: UpdateWhatsappWebSettingsDto,
  ) {
    const prefs = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (!prefs) {
      throw new BadRequestException('Link a WhatsApp number first.');
    }
    if (dto.useForSending) {
      const live = await this.waAkg.getSession(
        sessionIdFor(organizationId),
      );
      if (live?.status !== 'CONNECTED') {
        throw new BadRequestException(
          'Link your WhatsApp number before sending through it.',
        );
      }
    }
    await this.prisma.whatsappWebSession.update({
      where: { organizationId },
      data: {
        ...(dto.useForSending !== undefined
          ? { useForSending: dto.useForSending }
          : {}),
        ...(dto.autoReply !== undefined ? { autoReply: dto.autoReply } : {}),
        ...(dto.dailyLimit !== undefined ? { dailyLimit: dto.dailyLimit } : {}),
      },
    });
    return this.status(organizationId);
  }
}
