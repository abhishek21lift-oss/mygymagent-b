import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { parseWaAuthKey } from './wa-auth.store';
import { WaSessionManager } from './wa-session.manager';
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
 * A gym's own WhatsApp number, served in-process: linking status, QR and
 * pairing-code passthrough from the session manager, and the gym's
 * sending preferences. Liveness comes from the manager and `WaSession`;
 * only preferences live in the local row.
 */
@Injectable()
export class WhatsappWebService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly manager: WaSessionManager,
  ) {}

  /**
   * Whether this deployment can run WhatsApp: the session vault key set,
   * or the DISABLED reason the settings page names.
   */
  availability():
    | { available: true; unavailableReason: null }
    | { available: false; unavailableReason: 'DISABLED' } {
    try {
      parseWaAuthKey(this.config.get<string>('WA_AUTH_KEY'));
    } catch {
      return { available: false, unavailableReason: 'DISABLED' };
    }
    return { available: true, unavailableReason: null };
  }

  available(): boolean {
    return this.availability().available;
  }

  async status(organizationId: string) {
    const [prefs, session, sentLast24h, codes, live] = await Promise.all([
      this.prisma.whatsappWebSession.findUnique({
        where: { organizationId },
      }),
      this.prisma.waSession.findUnique({ where: { organizationId } }),
      this.prisma.messageLog.count({
        where: {
          organizationId,
          channel: 'WHATSAPP',
          providerMessageId: { startsWith: 'waakg:' },
          createdAt: { gte: new Date(Date.now() - DAY_MS) },
        },
      }),
      this.manager.codes(organizationId),
      this.manager.getStatus(organizationId),
    ]);
    const connected = live === 'CONNECTED';
    return {
      ...this.availability(),
      ...(prefs ?? PREF_DEFAULTS),
      phoneNumber: connected
        ? (session?.phoneNumber ?? prefs?.phoneNumber ?? null)
        : null,
      status: live,
      connectedAt: connected ? (session?.connectedAt ?? null) : null,
      lastError: session?.lastError ?? null,
      sentLast24h,
      qrDataUrl: live === 'PAIRING' ? codes.qrDataUrl : null,
      pairingCode: live === 'PAIRING' ? codes.pairingCode : null,
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
    if ((await this.manager.getStatus(organizationId)) === 'CONNECTED') {
      throw new ConflictException(
        'A number is already linked. Unlink it first to link a different one.',
      );
    }
    await this.manager.connect(organizationId, {
      pairingPhone: dto.phoneNumber,
    });
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
    await this.manager.disconnect(organizationId);
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
      if ((await this.manager.getStatus(organizationId)) !== 'CONNECTED') {
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
