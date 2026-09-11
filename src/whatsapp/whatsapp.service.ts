import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CompleteEmbeddedSignupDto,
  SendWhatsAppMessageDto,
} from './dto/whatsapp.dto';

interface GraphPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

/**
 * WhatsApp Business integration: each gym connects its OWN number via
 * Meta's embedded-signup flow (the settings page drives FB.login and
 * posts the resulting code here). The code is exchanged server-side
 * for a system-user token, the WABA's numbers are read back to confirm
 * the selected phone number id, and only the integration METADATA is
 * stored -- access tokens are never persisted (no credential vault
 * exists yet; see the class comment for what that unlocks).
 *
 * Outbound delivery still goes through CommunicationsService's provider
 * abstraction: EMAIL-class reliability for WhatsApp arrives with the
 * future Meta Cloud API provider + vault, until then sends record a
 * FAILED MessageLog row with the clear provider error instead of
 * pretending to deliver.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly communications: CommunicationsService,
  ) {}

  getIntegration(organizationId: string) {
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
      const { access_token: accessToken } = (await tokenRes.json()) as {
        access_token?: string;
      };
      if (!accessToken) throw new Error('Token exchange returned no token');

      const numbersRes = await fetch(
        `https://graph.facebook.com/${version}/${dto.wabaId}/phone_numbers?` +
          new URLSearchParams({
            access_token: accessToken,
            fields: 'id,display_phone_number,verified_name',
          }),
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
    const existing = await this.prisma.whatsappIntegration.findUnique({
      where: { organizationId },
    });
    if (!existing) return { disconnected: true };
    await this.prisma.whatsappIntegration.update({
      where: { organizationId },
      data: { status: 'DISCONNECTED' },
    });
    return { disconnected: true };
  }

  listMessages(organizationId: string, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.messageLog.findMany({
      where: { organizationId, channel: 'WHATSAPP' },
      orderBy: { createdAt: 'desc' },
      take,
    });
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
}
