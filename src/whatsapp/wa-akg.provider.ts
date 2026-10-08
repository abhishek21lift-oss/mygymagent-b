import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { MessageProvider } from '../communications/interfaces/message-provider.interface';

const SEND_TIMEOUT_MS = 8_000;

/** Deterministic WA-AKG session per gym: no mapping table, the session
 * name IS the derivation, and the webhook reverses it the same way. */
export function sessionIdFor(organizationId: string): string {
  return `gym-${organizationId}`;
}

const INDIA_TIMEZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);

/**
 * A phone number as a WhatsApp JID. Same rule as the removed
 * `normaliseWhatsappNumber`: an Indian gym's local numbers get +91, any
 * other short number is refused rather than guessed at, because a wrong
 * country code messages a stranger.
 */
export function toJid(
  raw: string,
  organization: { currency: string; timezone: string } | null,
): string {
  const international =
    raw.trim().startsWith('+') || raw.trim().startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('00')) digits = digits.slice(2);
  const indian =
    organization?.currency === 'INR' ||
    INDIA_TIMEZONES.has(organization?.timezone ?? '');

  if (!international && indian) {
    if (digits.length === 10) digits = `91${digits}`;
    else if (digits.length === 11 && digits.startsWith('0'))
      digits = `91${digits.slice(1)}`;
  }
  if (digits.length < 11 || digits.length > 15) {
    throw new BadRequestException(
      `"${raw}" isn't a WhatsApp number we can use. Save it with the country code, e.g. +91 98765 43210.`,
    );
  }
  return `${digits}@s.whatsapp.net`;
}

/**
 * The WHATSAPP channel, served by the shared WA-AKG gateway instead of
 * the removed Meta Cloud API / in-process Baileys stack: one WA-AKG
 * session per gym, free-form text sends, provider id `waakg:<id>` on
 * MessageLog for the status webhook to advance.
 */
@Injectable()
export class WaAkgProvider implements MessageProvider {
  private readonly logger = new Logger(WaAkgProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    return !!(this.baseUrl() && this.apiKey());
  }

  private baseUrl(): string {
    return (this.config.get<string>('WA_AKG_BASE_URL', '') ?? '').replace(
      /\/+$/,
      '',
    );
  }

  private apiKey(): string {
    return this.config.get<string>('WA_AKG_API_KEY', '') ?? '';
  }

  async send(message: {
    to: string;
    text: string;
    organizationId?: string;
  }): Promise<string> {
    const notConfigured = new ServiceUnavailableException(
      "WhatsApp sending isn't configured",
    );
    if (!this.isConfigured() || !message.organizationId) throw notConfigured;
    const { organizationId } = message;

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true, timezone: true },
    });
    // A missing org row degrades to non-Indian: full international numbers
    // still send, local ones fail with the country-code error below.
    const jid = toJid(message.to, organization);
    const sessionId = sessionIdFor(organizationId);
    await this.ensureSession(sessionId);

    const res = await this.post(
      `/api/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(jid)}/send`,
      { message: { text: message.text } },
    );
    const data = (res ?? {}) as {
      key?: { id?: string };
      id?: string;
      messageId?: string;
    };
    const id = data.key?.id ?? data.id ?? data.messageId;
    if (!id) throw new Error('WhatsApp send failed: no message id returned');
    return `waakg:${id}`;
  }

  private async ensureSession(sessionId: string): Promise<void> {
    const headers = { 'X-API-Key': this.apiKey() };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${this.baseUrl()}/api/sessions/${encodeURIComponent(sessionId)}`,
        { headers, signal: controller.signal },
      );
      if (res.ok) return;
      if (res.status !== 404) {
        throw new Error(`Session lookup failed (${res.status})`);
      }
      const created = await fetch(`${this.baseUrl()}/api/sessions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sessionId }),
        signal: controller.signal,
      });
      if (!created.ok) {
        throw new Error(`Session creation failed (${created.status})`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`WhatsApp send timed out after ${SEND_TIMEOUT_MS / 1000}s`);
      }
      throw error instanceof Error ? error : new Error('WhatsApp send failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(path: string, payload: Record<string, unknown>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl()}${path}`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`WhatsApp send failed (${res.status})`);
      }
      const body = (await res.json()) as { status?: boolean; data?: unknown };
      if (body.status === false) {
        throw new Error('WhatsApp send failed: gateway refused the message');
      }
      return body.data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`WhatsApp send timed out after ${SEND_TIMEOUT_MS / 1000}s`);
      }
      throw error instanceof Error ? error : new Error('WhatsApp send failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
