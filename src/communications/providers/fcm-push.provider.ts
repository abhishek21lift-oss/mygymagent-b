import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';
import { ChannelNotConfiguredError } from '../interfaces/email-provider.interface';
import type { MessageProvider } from '../interfaces/message-provider.interface';

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_API_BASE_URL = 'https://fcm.googleapis.com';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 8_000;
/** Refresh this long before Google's stated expiry, so a token is never
 * presented in the last seconds of its life. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Opened when the notification is tapped. Relative paths are fine:
   * the client resolves them against its own origin. */
  url?: string;
  /** String values only -- FCM rejects anything else in `data`. */
  data?: Record<string, string>;
}

/**
 * The device token is gone for good: uninstalled, signed out, or issued
 * by a different Firebase project. The caller should deactivate it rather
 * than retry, because every retry will fail the same way.
 */
export class PushTokenInvalidError extends Error {
  constructor(
    message: string,
    readonly fcmErrorCode: string,
  ) {
    super(message);
    this.name = 'PushTokenInvalidError';
  }
}

/**
 * Push over Firebase Cloud Messaging's HTTP v1 API.
 *
 * Deliberately not `firebase-admin`: that SDK is a large dependency tree
 * for what is two HTTPS calls -- exchange a signed JWT for an OAuth token,
 * then POST the message -- and both are done here with Node's own
 * `crypto` and `fetch`. The service account is the one credential, given
 * as `FCM_SERVICE_ACCOUNT_JSON` (the JSON file Firebase issues, raw or
 * base64-encoded, so it survives hosts that mangle newlines in env vars).
 *
 * FCM tokens cover Android, iOS (FCM relays to APNs) and web push, so one
 * provider serves every client this product ships.
 *
 * Unconfigured throws `ChannelNotConfiguredError`, never silently drops:
 * a push that was never sent must not be logged as one that was.
 */
@Injectable()
export class FcmPushProvider implements MessageProvider {
  private readonly logger = new Logger(FcmPushProvider.name);
  private cachedAccessToken: { value: string; expiresAt: number } | null = null;
  private accessTokenInFlight: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return this.serviceAccount() !== null;
  }

  /**
   * `MessageProvider` shape, for `CommunicationsService`'s generic channel
   * dispatch: `to` is an FCM registration token. The notification path
   * uses `sendToToken` directly, since a push has a title and a link that
   * the generic `{to, text}` shape cannot carry.
   */
  async send(message: {
    to: string;
    text: string;
    organizationId?: string;
  }): Promise<string> {
    return this.sendToToken(message.to, {
      title: this.config.get<string>('FCM_DEFAULT_TITLE', 'THE CULT CLIENT'),
      body: message.text,
    });
  }

  /** Returns FCM's message name (`projects/…/messages/…`). */
  async sendToToken(token: string, payload: PushPayload): Promise<string> {
    const account = this.serviceAccount();
    if (!account) {
      throw new ChannelNotConfiguredError(
        'Push is not configured on this deployment (FCM_SERVICE_ACCOUNT_JSON)',
      );
    }

    const body = JSON.stringify({ message: this.buildMessage(token, payload) });
    let res = await this.postMessage(account, body);
    if (res.status === 401) {
      // A revoked or clock-skewed token: drop it and try once more with a
      // fresh one before calling it a failure.
      this.cachedAccessToken = null;
      res = await this.postMessage(account, body);
    }

    const json = (await res.json().catch(() => ({}))) as {
      name?: string;
      error?: {
        status?: string;
        message?: string;
        details?: Array<{ '@type'?: string; errorCode?: string }>;
      };
    };
    if (res.ok && json.name) return json.name;

    const fcmCode =
      json.error?.details?.find((d) => d.errorCode)?.errorCode ??
      json.error?.status ??
      `HTTP_${res.status}`;
    const detail = json.error?.message ?? `HTTP ${res.status}`;
    if (this.isDeadToken(res.status, fcmCode, detail)) {
      throw new PushTokenInvalidError(
        `FCM rejected the device token (${fcmCode}): ${detail}`,
        fcmCode,
      );
    }
    throw new Error(`FCM send failed (${fcmCode}): ${detail}`);
  }

  /**
   * UNREGISTERED and SENDER_ID_MISMATCH are permanent by definition.
   * INVALID_ARGUMENT is ambiguous -- it also covers a malformed payload,
   * which is our bug, not the device's -- so it only counts when FCM says
   * the token itself is what it objects to.
   */
  private isDeadToken(status: number, code: string, detail: string): boolean {
    if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return true;
    if (status === 404 && code === 'NOT_FOUND') return true;
    return code === 'INVALID_ARGUMENT' && /registration token/i.test(detail);
  }

  private buildMessage(token: string, payload: PushPayload) {
    const data: Record<string, string> = { ...(payload.data ?? {}) };
    if (payload.url) data.url = payload.url;
    return {
      token,
      notification: { title: payload.title, body: payload.body },
      ...(Object.keys(data).length ? { data } : {}),
      android: { priority: 'HIGH' },
      apns: { headers: { 'apns-priority': '10' } },
      // Web push opens this link on click. FCM requires it absolute and
      // https, so a relative path is left to the service worker via
      // `data.url` rather than sent here and rejected.
      ...(payload.url && /^https:\/\//.test(payload.url)
        ? { webpush: { fcm_options: { link: payload.url } } }
        : {}),
    };
  }

  private async postMessage(
    account: ServiceAccount,
    body: string,
  ): Promise<Response> {
    const accessToken = await this.accessToken(account);
    const base = this.config.get<string>(
      'FCM_API_BASE_URL',
      DEFAULT_API_BASE_URL,
    );
    return fetch(
      `${base}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  }

  /** One exchange in flight at a time: a burst of pushes at startup would
   * otherwise each mint their own OAuth token. */
  private accessToken(account: ServiceAccount): Promise<string> {
    const cached = this.cachedAccessToken;
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return Promise.resolve(cached.value);
    }
    this.accessTokenInFlight ??= this.exchangeToken(account).finally(() => {
      this.accessTokenInFlight = null;
    });
    return this.accessTokenInFlight;
  }

  private async exchangeToken(account: ServiceAccount): Promise<string> {
    const tokenUrl = this.config.get<string>(
      'FCM_TOKEN_URL',
      DEFAULT_TOKEN_URL,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const assertion = this.signJwt(account, {
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: tokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      // Never log the assertion or the key -- only what Google said.
      throw new Error(
        `FCM OAuth token exchange failed (HTTP ${res.status}): ${json.error_description ?? json.error ?? 'no access_token'}`,
      );
    }
    this.cachedAccessToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }

  private signJwt(account: ServiceAccount, claims: Record<string, unknown>) {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(account.private_key)
      .toString('base64url');
    return `${unsigned}.${signature}`;
  }

  private parsedFor: string | undefined;
  private parsed: ServiceAccount | null = null;

  /** Parsed once per distinct value; a malformed value reads as
   * unconfigured (with one warning) rather than failing every send with a
   * JSON error that hides the real problem. */
  private serviceAccount(): ServiceAccount | null {
    const raw = this.config.get<string>('FCM_SERVICE_ACCOUNT_JSON', '').trim();
    if (raw === this.parsedFor) return this.parsed;
    this.parsedFor = raw;
    this.parsed = null;
    if (!raw) return null;
    try {
      const text = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      const value = JSON.parse(text) as Partial<ServiceAccount>;
      if (!value.project_id || !value.client_email || !value.private_key) {
        throw new Error('missing project_id, client_email or private_key');
      }
      this.parsed = {
        project_id: value.project_id,
        client_email: value.client_email,
        // Hosts that store the key on one line keep its newlines escaped.
        private_key: value.private_key.replace(/\\n/g, '\n'),
      };
    } catch (error) {
      this.logger.warn(
        `FCM_SERVICE_ACCOUNT_JSON is set but unusable (${error instanceof Error ? error.message : String(error)}); push stays disabled`,
      );
    }
    return this.parsed;
  }
}
