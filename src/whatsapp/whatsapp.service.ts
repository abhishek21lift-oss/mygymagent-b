import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { decryptWhatsAppToken, encryptWhatsAppToken } from './whatsapp.crypto';

export interface IntegrationRow { id: string; organization_id: string; phone_number_id: string; business_account_id: string | null; display_phone_number: string | null; display_name: string | null; status: string; last_verified_at: Date | null; }
interface ConnectInput { phoneNumberId: string; businessAccountId?: string; accessToken: string; displayPhoneNumber?: string; displayName?: string; }

@Injectable()
export class WhatsAppService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private encryptionKey(): string { return this.config.get<string>('WHATSAPP_ENCRYPTION_KEY') ?? ''; }
  private graphVersion(): string { return this.config.get<string>('WHATSAPP_GRAPH_VERSION', 'v23.0'); }

  async getIntegration(organizationId: string) {
    const rows = await this.prisma.$queryRaw<IntegrationRow[]>(Prisma.sql`SELECT id, organization_id, phone_number_id, business_account_id, display_phone_number, display_name, status, last_verified_at FROM whatsapp_integrations WHERE organization_id = ${organizationId} LIMIT 1`);
    return rows[0] ?? null;
  }

  async connect(organizationId: string, input: ConnectInput) {
    if (!this.encryptionKey()) throw new ServiceUnavailableException('WhatsApp encryption is not configured');
    if (!input.phoneNumberId || !input.accessToken) throw new BadRequestException('phoneNumberId and accessToken are required');
    const verified = await this.verifyToken(input.phoneNumberId, input.accessToken);
    const encrypted = encryptWhatsAppToken(input.accessToken, this.encryptionKey());
    const existing = await this.getIntegration(organizationId);
    if (existing) {
      await this.prisma.$executeRaw(Prisma.sql`UPDATE whatsapp_integrations SET phone_number_id=${input.phoneNumberId}, business_account_id=${input.businessAccountId ?? null}, display_phone_number=${input.displayPhoneNumber ?? verified.displayPhoneNumber ?? null}, display_name=${input.displayName ?? verified.displayName ?? null}, encrypted_access_token=${encrypted}, status='CONNECTED', last_verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE organization_id=${organizationId}`);
    } else {
      await this.prisma.$executeRaw(Prisma.sql`INSERT INTO whatsapp_integrations (id, organization_id, phone_number_id, business_account_id, display_phone_number, display_name, encrypted_access_token, status, last_verified_at) VALUES (${randomUUID()}, ${organizationId}, ${input.phoneNumberId}, ${input.businessAccountId ?? null}, ${input.displayPhoneNumber ?? verified.displayPhoneNumber ?? null}, ${input.displayName ?? verified.displayName ?? null}, ${encrypted}, 'CONNECTED', CURRENT_TIMESTAMP)`);
    }
    return this.getIntegration(organizationId);
  }

  async disconnect(organizationId: string) {
    await this.prisma.$executeRaw(Prisma.sql`UPDATE whatsapp_integrations SET status='DISCONNECTED', encrypted_access_token='', updated_at=CURRENT_TIMESTAMP WHERE organization_id=${organizationId}`);
    return { disconnected: true };
  }

  async sendText(organizationId: string, to: string, text: string) {
    if (!/^\+?[1-9]\d{7,14}$/.test(to)) throw new BadRequestException('Recipient must be an international phone number');
    if (!text.trim()) throw new BadRequestException('Message text is required');
    const rows = await this.prisma.$queryRaw<(IntegrationRow & { encrypted_access_token: string })[]>(Prisma.sql`SELECT id, organization_id, phone_number_id, business_account_id, display_phone_number, display_name, status, last_verified_at, encrypted_access_token FROM whatsapp_integrations WHERE organization_id=${organizationId} AND status='CONNECTED' LIMIT 1`);
    const integration = rows[0];
    if (!integration?.encrypted_access_token) throw new ServiceUnavailableException('WhatsApp is not connected for this studio');
    const token = decryptWhatsAppToken(integration.encrypted_access_token, this.encryptionKey());
    const response = await fetch(`https://graph.facebook.com/${this.graphVersion()}/${integration.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body: text } }) });
    const body = await response.json() as { messages?: Array<{ id: string }>; error?: { message?: string } };
    if (!response.ok) throw new BadRequestException(body.error?.message ?? 'Meta WhatsApp API rejected the message');
    const providerMessageId = body.messages?.[0]?.id ?? null;
    await this.prisma.$executeRaw(Prisma.sql`INSERT INTO whatsapp_messages (id, organization_id, phone_number_id, provider_message_id, direction, to_number, message_type, text, status, created_at, updated_at) VALUES (${randomUUID()}, ${organizationId}, ${integration.phone_number_id}, ${providerMessageId}, 'OUTBOUND', ${to}, 'text', ${text}, 'SENT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    return { providerMessageId, status: 'SENT' };
  }

  async webhookVerify(mode: string | undefined, token: string | undefined, challenge: string | undefined) {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (!expected || mode !== 'subscribe' || !token || !challenge || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw new BadRequestException('Webhook verification failed');
    return challenge;
  }

  async handleWebhook(payload: any) {
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];
    let processed = 0;
    for (const entry of entries) for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const rows = await this.prisma.$queryRaw<{ organization_id: string }[]>(Prisma.sql`SELECT organization_id FROM whatsapp_integrations WHERE phone_number_id=${phoneNumberId} AND status='CONNECTED' LIMIT 1`);
      const organizationId = rows[0]?.organization_id;
      if (!organizationId) continue;
      for (const message of value?.messages ?? []) {
        const text = message?.text?.body ?? null;
        await this.prisma.$executeRaw(Prisma.sql`INSERT INTO whatsapp_messages (id, organization_id, phone_number_id, provider_message_id, direction, from_number, to_number, message_type, text, status, raw_payload, created_at, updated_at) VALUES (${randomUUID()}, ${organizationId}, ${phoneNumberId}, ${message?.id ?? null}, 'INBOUND', ${message?.from ?? null}, ${phoneNumberId}, ${message?.type ?? 'unknown'}, ${text}, 'RECEIVED', ${JSON.stringify(message)}::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (provider_message_id) DO NOTHING`);
        processed++;
      }
      for (const status of value?.statuses ?? []) {
        await this.prisma.$executeRaw(Prisma.sql`UPDATE whatsapp_messages SET status=${String(status?.status ?? 'UNKNOWN').toUpperCase()}, updated_at=CURRENT_TIMESTAMP WHERE provider_message_id=${status?.id ?? ''} AND organization_id=${organizationId}`);
      }
    }
    return { received: true, processed };
  }

  private async verifyToken(phoneNumberId: string, accessToken: string) {
    const response = await fetch(`https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await response.json() as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
    if (!response.ok) throw new BadRequestException(body.error?.message ?? 'Unable to verify WhatsApp credentials with Meta');
    return { displayPhoneNumber: body.display_phone_number, displayName: body.verified_name };
  }

  async listMessages(organizationId: string, limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return this.prisma.$queryRaw(Prisma.sql`SELECT id, phone_number_id, provider_message_id, direction, from_number, to_number, message_type, text, status, created_at, updated_at FROM whatsapp_messages WHERE organization_id=${organizationId} ORDER BY created_at DESC LIMIT ${safeLimit}`);
  }
}
