import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelNotConfiguredError } from '../interfaces/email-provider.interface';
import type { MessageProvider } from '../interfaces/message-provider.interface';

const MSG91_DEFAULT_FLOW_URL = 'https://control.msg91.com/api/v5/flow/';
const MSG91_TIMEOUT_MS = 8_000;

/**
 * SMS over MSG91, used to carry member login codes.
 *
 * MSG91 also sells an OTP endpoint that generates and verifies the code
 * itself. This deliberately does not use it: that would put the secret
 * behind a login, and the decision about whether someone may enter, on
 * the other side of a third-party API. The code is generated, hashed,
 * expired and counted here (see `MemberOtpService`), and MSG91's only
 * job is delivery -- which is what makes this an ordinary
 * `MessageProvider` that the rest of the codebase can use for any SMS,
 * rather than an authentication dependency.
 *
 * Indian SMS is DLT-regulated: a sender id and a template registered
 * with the operator are mandatory, and the template's variable names are
 * fixed at registration. `MSG91_OTP_TEMPLATE_ID` is that registered
 * template, and `MSG91_OTP_VAR` (default `otp`) is the variable inside
 * it the code is substituted into -- configurable because the name is
 * chosen when the template is approved, not by us.
 *
 * Unconfigured throws, never silently drops: a login code that was never
 * sent must not look like one that was.
 */
@Injectable()
export class Msg91SmsProvider implements MessageProvider {
  private readonly logger = new Logger(Msg91SmsProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get authKey(): string {
    return this.config.get<string>('MSG91_AUTH_KEY', '');
  }

  private get templateId(): string {
    return this.config.get<string>('MSG91_OTP_TEMPLATE_ID', '');
  }

  /** Overridable because MSG91 serves regional endpoints, and because a
   * test needs somewhere to point that is not the live carrier. */
  private get flowUrl(): string {
    return this.config.get<string>('MSG91_FLOW_URL', MSG91_DEFAULT_FLOW_URL);
  }

  /** True when a send would actually reach MSG91. Callers use this to
   * refuse a login flow up front rather than issue a code that cannot be
   * delivered. */
  isConfigured(): boolean {
    return Boolean(this.authKey && this.templateId);
  }

  /**
   * `text` is the code itself, not a sentence: under DLT the wording
   * lives in the approved template and only the variable travels. A
   * provider that accepted free text here would compose a message the
   * operator rejects.
   */
  async send(message: {
    to: string;
    text: string;
    organizationId?: string;
  }): Promise<string | void> {
    if (!this.isConfigured()) {
      throw new ChannelNotConfiguredError(
        'MSG91 is not configured on this deployment (MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID)',
      );
    }

    // MSG91 wants the number without a leading `+`, country code first.
    const recipient = message.to.replace(/^\+/, '');
    const variable = this.config.get<string>('MSG91_OTP_VAR', 'otp');
    const senderId = this.config.get<string>('MSG91_SENDER_ID', '');

    const body: Record<string, unknown> = {
      template_id: this.templateId,
      recipients: [{ mobiles: recipient, [variable]: message.text }],
    };
    if (senderId) body.sender = senderId;

    let res: Response;
    try {
      res = await fetch(this.flowUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authkey: this.authKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MSG91_TIMEOUT_MS),
      });
    } catch (error) {
      // The code never left the building; say so rather than letting the
      // caller report a delivered message.
      throw new Error(
        `MSG91 request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const payload = (await res.json().catch(() => ({}))) as {
      type?: string;
      message?: string;
      request_id?: string;
    };

    // MSG91 answers 200 with `type: "error"` for a rejected template or a
    // bad number, so the status code alone does not mean delivered.
    if (!res.ok || payload.type === 'error') {
      const detail = payload.message ?? `HTTP ${res.status}`;
      // The recipient is not logged: it identifies the person logging in.
      this.logger.warn(`MSG91 rejected a send: ${detail}`);
      throw new Error(`MSG91 rejected the message: ${detail}`);
    }

    return payload.request_id;
  }
}
