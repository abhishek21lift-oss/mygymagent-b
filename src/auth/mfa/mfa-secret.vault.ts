import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Crypto for the per-user TOTP secret vault (ciphertext lives in
 * `UserMfa.secretEnc`; the key lives only in the `MFA_TOTP_KEY` env var,
 * never in the database, logs, or API responses).
 *
 * Deliberately the same envelope as `whatsapp-token.vault.ts`
 * (`v1.<ivHex>.<tagHex>.<cipherHex>`, AES-256-GCM, 12-byte iv) rather than
 * a second scheme: one reviewed format for "secret the server must be able
 * to read back" is easier to reason about than two. It is a separate key
 * and a separate module because the blast radius of the two secrets is
 * different -- leaking a WhatsApp token lets an attacker send messages,
 * leaking TOTP secrets defeats every second factor at once.
 */
const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;

/**
 * Parses the vault key: missing, blank, or not exactly 32 bytes of hex is
 * a 503 rather than a crash, matching how the WhatsApp vault reports an
 * unconfigured deployment. Never logs the key material.
 *
 * Generate one with: `openssl rand -hex 32`.
 */
export function parseMfaVaultKey(keyHex: string | undefined): Buffer {
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new ServiceUnavailableException(
      'Two-factor authentication is not configured on this deployment (MFA_TOTP_KEY)',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptMfaSecret(plaintext: string, key: Buffer): string {
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

/** Throws on any malformed/tampered envelope or wrong key. The ciphertext
 * and key are never included in the error. */
export function decryptMfaSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Malformed MFA secret envelope');
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
    throw new Error('Failed to decrypt MFA secret');
  }
}
