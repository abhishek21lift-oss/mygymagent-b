import { assertPublicUrl, WebhookBlockedError } from './webhook-ssrf';
import { signWebhook } from './webhook-sign';

export interface WebhookPayload {
  event: string;
  organizationId: string;
  timestamp: string;
  data: unknown;
}

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;

/** The receiver answered non-2xx: retryable. */
export class WebhookHttpError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number) {
    super(`Webhook receiver answered ${httpStatus}`);
    this.name = 'WebhookHttpError';
    this.httpStatus = httpStatus;
  }
}

/** Timeouts, refused connections, DNS mid-flight: retryable. */
export class WebhookNetworkError extends Error {
  constructor(reason: string) {
    super(`Webhook delivery failed: ${reason}`);
    this.name = 'WebhookNetworkError';
  }
}

export { WebhookBlockedError };

/**
 * POSTs one signed JSON payload. The exact bytes stringified here are
 * the bytes signed, so the receiver recomputes the same digest.
 * Redirects are followed manually (max 2) with the SSRF guard re-run
 * on every hop; anything past that is a receiver misconfiguration and
 * — like any other refusal — never retried.
 */
export async function postWebhook(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<{ httpStatus: number }> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${signWebhook(secret, rawBody)}`;
  let current = await assertPublicUrl(url);
  for (let hop = 0; ; hop += 1) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: rawBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new WebhookNetworkError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (res.status >= 200 && res.status < 300) {
      await res.arrayBuffer().catch(() => undefined);
      return { httpStatus: res.status };
    }
    const location = res.headers.get('location');
    await res.arrayBuffer().catch(() => undefined);
    if (
      location &&
      res.status >= 300 &&
      res.status < 400 &&
      hop < MAX_REDIRECTS
    ) {
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }
    if (location && res.status >= 300 && res.status < 400) {
      throw new WebhookBlockedError('too many redirects');
    }
    throw new WebhookHttpError(res.status);
  }
}
