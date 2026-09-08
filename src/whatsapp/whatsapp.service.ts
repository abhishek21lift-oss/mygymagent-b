import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { decryptWhatsAppToken, encryptWhatsAppToken } from './whatsapp.crypto';

export interface IntegrationRow {
  id: string;
  organization_id: string;
  waba_id: string | null;
  phone_number_id: string;
  business_account_id: string | null;
  display_phone_number: string | null;
  display_name: string | null;
  status: string;
  last_verified_at: Date | null;
}

interface ConnectInput {
  phoneNumberId: string;
  wabaId?: string;
  businessAccountId?: string;
  accessToken: string;
  displayPhoneNumber?: string;
  displayName?: string;
}

interface EmbeddedSignupInput {
  code: string;
  wabaId: string;
  phoneNumberId?: string;
}

interface WebhookMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
}
interface WebhookStatus {
  id?: string;
  status?: string;
}
interface WebhookValue {
  metadata?: { phone_number_id?: string };
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
}
interface WebhookChange {
  value?: WebhookValue;
}
interface WebhookEntry {
  id?: string;
  changes?: WebhookChange[];
}
interface WebhookPayload {
  entry?: WebhookEntry[];
}

@Injectable()
export class WhatsAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private encryptionKey(): string {
    return this.config.get<string>('WHATSAPP_ENCRYPTION_KEY') ?? '';
  }
  private graphVersion(): string {
    return this.config.get<string>('WHATSAPP_GRAPH_VERSION', 'v25.0');
  }
  private metaAppId(): string {
    return this.config.get<string>('META_APP_ID') ?? '';
  }
  private metaAppSecret(): string {
    return this.config.get<string>('META_APP_SECRET') ?? '';
  }

  async getIntegration(organizationId: string) {
    const rows = await this.prisma.$queryRaw<IntegrationRow[]>(Prisma.sql`
      SELECT id, organization_id, waba_id, phone_number_id, business_account_id,
             display_phone_number, display_name, status, last_verified_at
      FROM whatsapp_integrations WHERE organization_id = ${organizationId} LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Exchanges Meta's short-lived Embedded Signup code server-side, validates the selected WABA/phone,
   * subscribes the WABA to webhooks, and encrypts the resulting customer token at rest. */
  async completeEmbeddedSignup(
    organizationId: string,
    input: EmbeddedSignupInput,
  ) {
    if (!this.encryptionKey())
      throw new ServiceUnavailableException(
        'WhatsApp encryption is not configured',
      );
    if (!this.metaAppId() || !this.metaAppSecret())
      throw new ServiceUnavailableException(
        'Meta app credentials are not configured',
      );
    if (!input.code || !input.wabaId)
      throw new BadRequestException(
        'Embedded Signup did not return an authorization code and WABA ID',
      );

    const token = await this.exchangeSignupCode(input.code);
    const phones = await this.fetchWabaPhones(input.wabaId, token);
    const phone = input.phoneNumberId
      ? phones.find((item) => item.id === input.phoneNumberId)
      : phones.length === 1
        ? phones[0]
        : undefined;

    if (!phone) {
      throw new BadRequestException(
        input.phoneNumberId
          ? 'Selected phone number does not belong to the selected WhatsApp Business Account'
          : 'Meta did not return a unique business phone number for this WABA',
      );
    }

    await this.subscribeWaba(input.wabaId, token);
    return this.persistConnection(organizationId, {
      phoneNumberId: phone.id,
      wabaId: input.wabaId,
      businessAccountId: input.wabaId,
      accessToken: token,
      displayPhoneNumber: phone.displayPhoneNumber,
      displayName: phone.displayName,
    });
  }

  async connect(organizationId: string, input: ConnectInput) {
    if (!this.encryptionKey())
      throw new ServiceUnavailableException(
        'WhatsApp encryption is not configured',
      );
    if (!input.phoneNumberId || !input.accessToken)
      throw new BadRequestException(
        'phoneNumberId and accessToken are required',
      );
    const verified = await this.verifyToken(
      input.phoneNumberId,
      input.accessToken,
    );
    if (input.wabaId) await this.subscribeWaba(input.wabaId, input.accessToken);
    return this.persistConnection(organizationId, {
      ...input,
      wabaId: input.wabaId,
      businessAccountId: input.businessAccountId ?? input.wabaId,
      displayPhoneNumber:
        input.displayPhoneNumber ?? verified.displayPhoneNumber,
      displayName: input.displayName ?? verified.displayName,
    });
  }

  private async persistConnection(organizationId: string, input: ConnectInput) {
    const encrypted = encryptWhatsAppToken(
      input.accessToken,
      this.encryptionKey(),
    );
    const existing = await this.getIntegration(organizationId);
    if (existing) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE whatsapp_integrations SET
          waba_id=${input.wabaId ?? null}, phone_number_id=${input.phoneNumberId},
          business_account_id=${input.businessAccountId ?? null}, display_phone_number=${input.displayPhoneNumber ?? null},
          display_name=${input.displayName ?? null}, encrypted_access_token=${encrypted}, status='CONNECTED',
          last_verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE organization_id=${organizationId}
      `);
    } else {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO whatsapp_integrations
          (id, organization_id, waba_id, phone_number_id, business_account_id, display_phone_number,
           display_name, encrypted_access_token, status, last_verified_at)
        VALUES
          (${randomUUID()}, ${organizationId}, ${input.wabaId ?? null}, ${input.phoneNumberId},
           ${input.businessAccountId ?? null}, ${input.displayPhoneNumber ?? null}, ${input.displayName ?? null},
           ${encrypted}, 'CONNECTED', CURRENT_TIMESTAMP)
      `);
    }
    return this.getIntegration(organizationId);
  }

  async disconnect(organizationId: string) {
    const rows = await this.prisma.$queryRaw<
      (IntegrationRow & { encrypted_access_token: string })[]
    >(Prisma.sql`
      SELECT id, organization_id, waba_id, phone_number_id, business_account_id, display_phone_number,
             display_name, status, last_verified_at, encrypted_access_token
      FROM whatsapp_integrations WHERE organization_id=${organizationId} LIMIT 1
    `);
    const integration = rows[0];
    if (
      integration?.encrypted_access_token &&
      integration.waba_id &&
      this.encryptionKey()
    ) {
      try {
        await this.unsubscribeWaba(
          integration.waba_id,
          decryptWhatsAppToken(
            integration.encrypted_access_token,
            this.encryptionKey(),
          ),
        );
      } catch {
        /* already revoked */
      }
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE whatsapp_integrations SET status='DISCONNECTED', encrypted_access_token='', updated_at=CURRENT_TIMESTAMP
      WHERE organization_id=${organizationId}
    `);
    return { disconnected: true };
  }

  async sendText(organizationId: string, to: string, text: string) {
    if (!/^\+?[1-9]\d{7,14}$/.test(to))
      throw new BadRequestException(
        'Recipient must be an international phone number',
      );
    if (!text.trim()) throw new BadRequestException('Message text is required');
    const rows = await this.prisma.$queryRaw<
      (IntegrationRow & { encrypted_access_token: string })[]
    >(Prisma.sql`
      SELECT id, organization_id, waba_id, phone_number_id, business_account_id, display_phone_number,
             display_name, status, last_verified_at, encrypted_access_token
      FROM whatsapp_integrations WHERE organization_id=${organizationId} AND status='CONNECTED' LIMIT 1
    `);
    const integration = rows[0];
    if (!integration?.encrypted_access_token)
      throw new ServiceUnavailableException(
        'WhatsApp is not connected for this studio',
      );
    const token = decryptWhatsAppToken(
      integration.encrypted_access_token,
      this.encryptionKey(),
    );
    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${integration.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      },
    );
    const body = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string };
    };
    if (!response.ok)
      throw new BadRequestException(
        body.error?.message ?? 'Meta WhatsApp API rejected the message',
      );
    const providerMessageId = body.messages?.[0]?.id ?? null;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO whatsapp_messages (id, organization_id, phone_number_id, provider_message_id, direction,
        to_number, message_type, text, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${organizationId}, ${integration.phone_number_id}, ${providerMessageId},
        'OUTBOUND', ${to}, 'text', ${text}, 'SENT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    return { providerMessageId, status: 'SENT' };
  }

  webhookVerify(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ) {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (
      !expected ||
      mode !== 'subscribe' ||
      !token ||
      !challenge ||
      token.length !== expected.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      throw new BadRequestException('Webhook verification failed');
    }
    return challenge;
  }

  verifyWebhookSignature(
    signature: string | undefined,
    rawBody: Buffer | undefined,
  ) {
    const secret = this.metaAppSecret();
    if (!secret || !signature || !rawBody) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return (
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    );
  }

  async handleWebhook(payload: WebhookPayload) {
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    let processed = 0;
    for (const entry of entries)
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const rows = await this.prisma.$queryRaw<
          { organization_id: string }[]
        >(Prisma.sql`
        SELECT organization_id FROM whatsapp_integrations
        WHERE phone_number_id=${phoneNumberId} AND status='CONNECTED' LIMIT 1
      `);
        const organizationId = rows[0]?.organization_id;
        if (!organizationId) continue;
        for (const message of value?.messages ?? []) {
          const text = message.text?.body ?? null;
          await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO whatsapp_messages
            (id, organization_id, phone_number_id, provider_message_id, direction, from_number, to_number,
             message_type, text, status, raw_payload, created_at, updated_at)
          VALUES
            (${randomUUID()}, ${organizationId}, ${phoneNumberId}, ${message.id ?? null}, 'INBOUND',
             ${message.from ?? null}, ${phoneNumberId}, ${message.type ?? 'unknown'}, ${text}, 'RECEIVED',
             ${JSON.stringify(message)}::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (provider_message_id) DO NOTHING
        `);
          processed++;
        }
        for (const status of value?.statuses ?? []) {
          await this.prisma.$executeRaw(Prisma.sql`
          UPDATE whatsapp_messages SET status=${String(status.status ?? 'UNKNOWN').toUpperCase()}, updated_at=CURRENT_TIMESTAMP
          WHERE provider_message_id=${status.id ?? ''} AND organization_id=${organizationId}
        `);
        }
      }
    return { received: true, processed };
  }

  private async exchangeSignupCode(code: string): Promise<string> {
    const url = new URL(
      `https://graph.facebook.com/${this.graphVersion()}/oauth/access_token`,
    );
    url.searchParams.set('client_id', this.metaAppId());
    url.searchParams.set('client_secret', this.metaAppSecret());
    url.searchParams.set('code', code);
    const response = await fetch(url);
    const body = (await response.json()) as {
      access_token?: string;
      error?: { message?: string };
    };
    if (!response.ok || !body.access_token)
      throw new BadRequestException(
        body.error?.message ?? 'Meta Embedded Signup code exchange failed',
      );
    return body.access_token;
  }

  private async fetchWabaPhones(wabaId: string, token: string) {
    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const body = (await response.json()) as {
      data?: Array<{
        id: string;
        display_phone_number?: string;
        verified_name?: string;
      }>;
      error?: { message?: string };
    };
    if (!response.ok)
      throw new BadRequestException(
        body.error?.message ??
          'Unable to verify WhatsApp Business Account with Meta',
      );
    return (body.data ?? []).map((item) => ({
      id: item.id,
      displayPhoneNumber: item.display_phone_number,
      displayName: item.verified_name,
    }));
  }

  private async subscribeWaba(wabaId: string, token: string) {
    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${wabaId}/subscribed_apps`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await response.json()) as {
      success?: boolean;
      error?: { message?: string };
    };
    if (!response.ok || body.success === false)
      throw new BadRequestException(
        body.error?.message ??
          'Unable to subscribe WhatsApp Business Account to MyGymAgent webhooks',
      );
  }

  private async unsubscribeWaba(wabaId: string, token: string) {
    await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${wabaId}/subscribed_apps`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
  }

  private async verifyToken(phoneNumberId: string, accessToken: string) {
    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const body = (await response.json()) as {
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string };
    };
    if (!response.ok)
      throw new BadRequestException(
        body.error?.message ??
          'Unable to verify WhatsApp credentials with Meta',
      );
    return {
      displayPhoneNumber: body.display_phone_number,
      displayName: body.verified_name,
    };
  }

  async listMessages(organizationId: string, limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT id, phone_number_id, provider_message_id, direction, from_number, to_number, message_type, text, status, created_at, updated_at
      FROM whatsapp_messages WHERE organization_id=${organizationId} ORDER BY created_at DESC LIMIT ${safeLimit}
    `);
  }
}
