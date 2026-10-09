import http from 'node:http';
import https from 'node:https';
import {
  assertPublicUrl,
  guardedLookup,
  WebhookBlockedError,
} from './webhook-ssrf';
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
    let res: { status: number; location: string | null };
    try {
      res = await postOnce(current, rawBody, signature);
    } catch (error) {
      if (error instanceof WebhookBlockedError) throw error;
      throw new WebhookNetworkError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (res.status >= 200 && res.status < 300) {
      return { httpStatus: res.status };
    }
    const location = res.location;
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

/**
 * One POST over node:http(s) rather than fetch, so the socket resolves
 * the host through guardedLookup: the addresses it connects to are the
 * addresses that were checked. The response body is drained and dropped.
 */
function postOnce(
  url: string,
  rawBody: string,
  signature: string,
): Promise<{ status: number; location: string | null }> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    // One deadline for the whole exchange, as AbortSignal.timeout gave
    // fetch: a receiver that trickles bytes can't hold the worker longer.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    const req = client.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'X-Webhook-Signature': signature,
        },
        lookup: guardedLookup as never,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          clearTimeout(deadline);
          const location = res.headers.location;
          resolve({
            status: res.statusCode ?? 0,
            location: typeof location === 'string' ? location : null,
          });
        });
        res.on('error', (error) => {
          clearTimeout(deadline);
          reject(error);
        });
      },
    );
    req.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.end(rawBody);
  });
}
