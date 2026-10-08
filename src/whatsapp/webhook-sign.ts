import crypto from 'node:crypto';

/**
 * `X-Webhook-Signature` value body: hex HMAC-SHA256 over the exact UTF-8
 * bytes POSTed, so a Zapier/n8n receiver recomputes the same digest.
 */
export function signWebhook(secret: string, rawBody: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
}
