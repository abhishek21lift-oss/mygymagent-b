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

export type WaAkgAction = 'start' | 'stop' | 'restart' | 'logout';

/** The slice of WA-AKG `GET /api/sessions/{id}` (`data`) this backend
 * reads: live status wins over the stored one, `me` carries the linked
 * number (`<digits>@s.whatsapp.net`), `qr` the raw QR payload while
 * pairing. Everything else on the payload is ignored. */
export interface WaAkgSession {
  status: string;
  qr?: string | null;
  pairingCode?: string | null;
  me?: { id?: string } | null;
}

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

  /**
   * The gym's WA-AKG session, or null when WA-AKG is unconfigured or the
   * gym has no session yet. Anything else (gateway down, auth refused)
   * throws -- callers turn that into a FAILED row or a 503, never a
   * silent "not connected".
   */
  async getSession(sessionId: string): Promise<WaAkgSession | null> {
    if (!this.isConfigured()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${this.baseUrl()}/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          headers: { 'X-API-Key': this.apiKey() },
          signal: controller.signal,
        },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Session lookup failed (${res.status})`);
      const body = (await res.json()) as { data?: WaAkgSession };
      return body.data ?? null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `WhatsApp gateway timed out after ${SEND_TIMEOUT_MS / 1000}s`,
        );
      }
      throw error instanceof Error ? error : new Error('WhatsApp send failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Creates the gym's session on first use: WA-AKG derives a random id
   * unless sessionId is explicit, so both name and sessionId are sent. */
  async ensureSession(sessionId: string): Promise<void> {
    if (await this.getSession(sessionId)) return;
    await this.post('/api/sessions', { name: sessionId, sessionId });
  }

  /** Lifecycle on an existing session: `start` begins pairing/sending,
   * `logout` unlinks the number (fresh QR next time). */
  async performAction(sessionId: string, action: WaAkgAction): Promise<void> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "WhatsApp sending isn't configured",
      );
    }
    await this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
      {},
    );
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
