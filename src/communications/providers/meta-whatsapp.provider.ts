import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  decryptWhatsappToken,
  parseWhatsappVaultKey,
} from '../../whatsapp/whatsapp-token.vault';
import type { MessageProvider } from '../interfaces/message-provider.interface';

/** Body of a Meta-approved template send
 * (`POST /{phone-number-id}/messages` with `type: template`) -- `name` is
 * the Meta-side template name, `languageCode` its locale (default en_US),
 * `components` the parameter blocks (`header`/`body`/`button`). */
export interface WhatsappTemplateSend {
  organizationId: string;
  to: string;
  name: string;
  languageCode?: string;
  components?: unknown[];
}

const GRAPH_TIMEOUT_MS = 8_000;

/**
 * Real WhatsApp delivery over the Meta Cloud API, per connected org: the
 * system-user token is decrypted from the vault on every send (never
 * cached, never logged), and the org's own `phoneNumberId` is the sender.
 * Unconfigured in any way (no vault key, no stored credential, no
 * connected number) means a 503 `ChannelNotConfigured`-style
 * ServiceUnavailable -- never a silent drop -- which CommunicationsService
 * records as FAILED in MessageLog like every other provider error.
 */
@Injectable()
export class MetaWhatsappProvider implements MessageProvider {
  private readonly logger = new Logger(MetaWhatsappProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private graphVersion(): string {
    return this.config.get<string>('WHATSAPP_GRAPH_VERSION', '') || 'v22.0';
  }

  /** Resolves the org's sender identity + plaintext token. Every failure
   * mode collapses to the same 503 message so callers (and API responses)
   * can't distinguish "no vault key" from "no credential" from "decrypt
   * failed" -- and none of them ever carry key/token material. */
  private async sendingContext(
    organizationId: string | undefined,
  ): Promise<{ phoneNumberId: string; token: string }> {
    const notConfigured = new ServiceUnavailableException(
      "WhatsApp sending isn't configured",
    );
    let key: Buffer;
    try {
      key = parseWhatsappVaultKey(
        this.config.get<string>('WHATSAPP_TOKEN_KEY', ''),
      );
    } catch {
      throw notConfigured;
    }
    if (!organizationId) throw notConfigured;
    const [credential, integration] = await Promise.all([
      this.prisma.whatsappCredential.findUnique({
        where: { organizationId },
      }),
      this.prisma.whatsappIntegration.findUnique({
        where: { organizationId },
      }),
    ]);
    if (!credential || !integration?.phoneNumberId) throw notConfigured;
    try {
      const token = decryptWhatsappToken(credential.accessTokenEnc, key);
      if (!token) throw new Error('empty token');
      return { phoneNumberId: integration.phoneNumberId, token };
    } catch {
      this.logger.warn(
        `WhatsApp credential for org ${organizationId} cannot be decrypted`,
      );
      throw notConfigured;
    }
  }

  /** Plain-text send (customer-service window / ad-hoc staff message). */
  async send(message: {
    to: string;
    text: string;
    organizationId?: string;
  }): Promise<string> {
    const { phoneNumberId, token } = await this.sendingContext(
      message.organizationId,
    );
    return this.post(phoneNumberId, token, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'text',
      text: { preview_url: false, body: message.text },
    });
  }

  /** Meta template send (outside the customer-service window) against an
   * org's Meta-approved template. Surfaced for automation/dunning flows;
   * the test-send endpoint goes through the template-keyed
   * CommunicationsService pipeline instead so the attempt is logged. */
  async sendTemplate(input: WhatsappTemplateSend): Promise<string> {
    const { phoneNumberId, token } = await this.sendingContext(
      input.organizationId,
    );
    return this.post(phoneNumberId, token, {
      messaging_product: 'whatsapp',
      to: input.to,
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.languageCode ?? 'en_US' },
        components: input.components ?? [],
      },
    });
  }

  private async post(
    phoneNumberId: string,
    token: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            // The token travels in the Authorization header only -- never
            // in the URL (which intermediaries log) and never in any error
            // message or log line below.
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        throw new Error(
          `WhatsApp send failed (${res.status}): ${await this.errorDetail(res)}`,
        );
      }
      const data = (await res.json()) as {
        messages?: Array<{ id?: string }>;
      };
      const id = data.messages?.[0]?.id;
      if (!id) throw new Error('WhatsApp send failed: no message id returned');
      return id;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `WhatsApp send timed out after ${GRAPH_TIMEOUT_MS / 1000}s`,
        );
      }
      throw error instanceof Error ? error : new Error('WhatsApp send failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort Graph error detail, truncated -- Graph error bodies never
   * contain our token, and this method never adds it. */
  private async errorDetail(res: Response): Promise<string> {
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: string };
        };
        return (parsed.error?.message ?? text).slice(0, 300);
      } catch {
        return text.slice(0, 300);
      }
    } catch {
      return 'unknown Graph error';
    }
  }
}
