import { hkdfSync } from 'crypto';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  parseMfaVaultKey,
} from '../auth/mfa/mfa-secret.vault';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * At-rest protection for outgoing-webhook signing secrets
 * (`WebhookSubscription.secret`).
 *
 * Same reviewed envelope as the TOTP vault (`v1.<ivHex>.<tagHex>.<cipherHex>`,
 * AES-256-GCM, 12-byte iv) -- the crypto is literally the MFA vault's -- but
 * under a subkey derived from `MFA_TOTP_KEY` with HKDF-SHA256 and a
 * webhook-specific `info`, so a webhook envelope can never be decrypted as
 * (or confused with) a TOTP envelope and vice versa.
 *
 * Rows written before this existed hold the 64-hex plaintext secret. Those
 * contain no '.', so they can never look like an envelope: anything that
 * does not start with `v1.` is legacy plaintext and keeps signing exactly
 * as before (no deploy-time migration). Anything that DOES start with `v1.`
 * must decrypt, or the caller fails closed.
 */
const ENVELOPE_PREFIX = 'v1.';
const HKDF_INFO = 'mygymagent/webhook-signing-secret/v1';

/** The stored value is an envelope that could not be opened (tampered,
 * truncated, or written under a different key). Message carries no
 * secret material and is safe to store on the delivery row. */
export class WebhookSecretUnreadableError extends Error {
  constructor() {
    super('webhook signing secret could not be decrypted');
    this.name = 'WebhookSecretUnreadableError';
  }
}

/**
 * Derives the webhook subkey. A missing/malformed `MFA_TOTP_KEY` is the
 * same 503 the MFA vault gives (optional at boot, feature unavailable
 * until set), worded for this feature. Never logs key material.
 */
export function deriveWebhookSecretKey(mfaKeyHex: string | undefined): Buffer {
  let ikm: Buffer;
  try {
    ikm = parseMfaVaultKey(mfaKeyHex);
  } catch {
    throw new ServiceUnavailableException(
      'Webhook secret encryption is not configured on this deployment (MFA_TOTP_KEY)',
    );
  }
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32));
}

export function isWebhookSecretEnvelope(stored: string): boolean {
  return stored.startsWith(ENVELOPE_PREFIX);
}

export function sealWebhookSecret(plaintext: string, key: Buffer): string {
  return encryptMfaSecret(plaintext, key);
}

/**
 * Returns the plaintext signing secret. Legacy plaintext is returned
 * as-is (and needs no key). An envelope with no key configured is a 503;
 * a bad envelope is `WebhookSecretUnreadableError` -- never a fallback to
 * signing with the raw column value.
 */
export function openWebhookSecret(
  stored: string,
  mfaKeyHex: string | undefined,
): string {
  if (!isWebhookSecretEnvelope(stored)) return stored;
  const key = deriveWebhookSecretKey(mfaKeyHex);
  try {
    return decryptMfaSecret(stored, key);
  } catch {
    throw new WebhookSecretUnreadableError();
  }
}

/**
 * Opens a subscription's secret for signing and, if the row still holds
 * legacy plaintext and a key is configured, re-encrypts it in place.
 * The rewrite is compare-and-set on the old value, so it can never
 * clobber a concurrent regenerate, and it is best effort: any failure is
 * logged and the delivery proceeds with the (correct) legacy secret.
 */
export async function resolveSigningSecret(
  prisma: PrismaService,
  sub: { id: string; secret: string },
  mfaKeyHex: string | undefined,
  logger?: Logger,
): Promise<string> {
  const plaintext = openWebhookSecret(sub.secret, mfaKeyHex);
  if (!isWebhookSecretEnvelope(sub.secret)) {
    let key: Buffer | null = null;
    try {
      key = deriveWebhookSecretKey(mfaKeyHex);
    } catch {
      key = null; // no key: legacy rows simply stay as they are
    }
    if (key) {
      try {
        await prisma.webhookSubscription.updateMany({
          where: { id: sub.id, secret: sub.secret },
          data: { secret: sealWebhookSecret(plaintext, key) },
        });
      } catch (error) {
        logger?.warn(
          `Could not re-encrypt legacy webhook secret for ${sub.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return plaintext;
}
