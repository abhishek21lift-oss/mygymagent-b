import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';

/**
 * The per-org WhatsApp credential vault's crypto (ciphertext lives in
 * `WhatsappCredential.accessTokenEnc`; the key lives only in the
 * `WHATSAPP_TOKEN_KEY` env var, never in the database, logs, or API
 * responses).
 *
 * Format is `v1.<ivHex>.<tagHex>.<cipherHex>` (AES-256-GCM, 12-byte iv).
 * The `v1` prefix versions the envelope so a future algorithm change can
 * be detected at decrypt time instead of failing as a opaque auth error.
 */
const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;

/** Parses the vault key, throwing the same 503 the connect/test-send
 * endpoints surface when WhatsApp sending isn't configured -- missing,
 * blank, or not exactly 32 bytes of hex. Never logs the key material. */
export function parseWhatsappVaultKey(keyHex: string | undefined): Buffer {
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new ServiceUnavailableException("WhatsApp sending isn't configured");
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptWhatsappToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('hex'),
    tag.toString('hex'),
    ciphertext.toString('hex'),
  ].join('.');
}

/** Throws on any malformed/tampered envelope or wrong key -- callers turn
 * that into the same 503 as a missing key (the failure is indistinguishable
 * from "not configured" to the outside, and the ciphertext/key are never
 * included in the error). */
export function decryptWhatsappToken(envelope: string, key: Buffer): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Malformed WhatsApp credential envelope');
  }
  const [, ivHex, tagHex, cipherHex] = parts;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt WhatsApp credential');
  }
}
