import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { parseWhatsappVaultKey } from '../whatsapp/whatsapp-token.vault';
import type {
  ConnectWhatsappWebDto,
  UpdateWhatsappWebSettingsDto,
} from './dto/whatsapp-web.dto';
import { WhatsappWebManager } from './whatsapp-web.manager';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WhatsappWebService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly manager: WhatsappWebManager,
  ) {}

  /** Whether this deployment can run WhatsApp Web at all: switched on,
   * and with a vault key to encrypt the session with. */
  available(): boolean {
    if (!this.manager.enabled) return false;
    try {
      parseWhatsappVaultKey(this.config.get<string>('WHATSAPP_TOKEN_KEY'));
      return true;
    } catch {
      return false;
    }
  }

  async status(organizationId: string) {
    const [session, sentLast24h] = await Promise.all([
      this.prisma.whatsappWebSession.findUnique({ where: { organizationId } }),
      this.prisma.messageLog.count({
        where: {
          organizationId,
          channel: 'WHATSAPP',
          providerMessageId: { startsWith: 'waweb:' },
          createdAt: { gte: new Date(Date.now() - DAY_MS) },
        },
      }),
    ]);
    const pairing = session?.status === 'PAIRING';
    const codes = pairing
      ? await this.manager.codes(organizationId)
      : { qrDataUrl: null, pairingCode: null };
    return {
      available: this.available(),
      status: session?.status ?? 'DISCONNECTED',
      phoneNumber: session?.phoneNumber ?? null,
      useForSending: session?.useForSending ?? false,
      dailyLimit: session?.dailyLimit ?? 200,
      sentLast24h,
      riskAcceptedAt: session?.riskAcceptedAt ?? null,
      connectedAt: session?.connectedAt ?? null,
      lastError: session?.lastError ?? null,
      ...codes,
    };
  }

  async connect(
    organizationId: string,
    userId: string,
    dto: ConnectWhatsappWebDto,
  ) {
    if (!this.available()) {
      throw new ServiceUnavailableException(
        "WhatsApp Web isn't available on this deployment.",
      );
    }
    const existing = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (existing?.status === 'CONNECTED') {
      throw new ConflictException(
        'A number is already linked. Unlink it first to link a different one.',
      );
    }
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
    try {
      await this.manager.connect(organizationId, {
        pairingPhone: dto.phoneNumber,
      });
    } catch (error) {
      await this.prisma.whatsappWebSession.update({
        where: { organizationId },
        data: {
          status: 'DISCONNECTED',
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
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
    const session = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (!session) {
      throw new BadRequestException('Link a WhatsApp number first.');
    }
    if (dto.useForSending && session.status !== 'CONNECTED') {
      throw new BadRequestException(
        'Link your WhatsApp number before sending through it.',
      );
    }
    await this.prisma.whatsappWebSession.update({
      where: { organizationId },
      data: {
        ...(dto.useForSending !== undefined
          ? { useForSending: dto.useForSending }
          : {}),
        ...(dto.dailyLimit !== undefined ? { dailyLimit: dto.dailyLimit } : {}),
      },
    });
    return this.status(organizationId);
  }
}
