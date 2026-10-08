import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;

/**
 * Parses the session vault key: missing, blank, or not exactly 32 bytes
 * of hex is a 503 rather than a crash. Never logs the key material.
 *
 * Generate one with: `openssl rand -hex 32`.
 */
export function parseWaAuthKey(keyHex: string | undefined): Buffer {
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new ServiceUnavailableException(
      'WhatsApp sessions are not configured on this deployment (WA_AUTH_KEY)',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    ENVELOPE_VERSION,
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext.toString('hex'),
  ].join('.');
}

function decrypt(envelope: string, key: Buffer): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Malformed session key envelope');
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
    throw new Error('Failed to decrypt session key');
  }
}

/**
 * Encrypted key-value storage for one linked number's Baileys session
 * state (`creds` plus per-key signal state) in `wa_auth_keys`.
 *
 * Constructed with the resolved `WaSession.id` (the manager upserts the
 * session row first, so every read/write here is keyed and cascading).
 * Plaintext values never reach the database, logs, or API responses.
 */
export class WaAuthStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly waSessionId: string,
    private readonly key: Buffer,
  ) {}

  async read(key: string): Promise<string | null> {
    const row = await this.prisma.waAuthKey.findUnique({
      where: { sessionId_key: { sessionId: this.waSessionId, key } },
      select: { valueEnc: true },
    });
    if (!row) return null;
    return decrypt(row.valueEnc, this.key);
  }

  async write(key: string, value: string): Promise<void> {
    await this.prisma.waAuthKey.upsert({
      where: { sessionId_key: { sessionId: this.waSessionId, key } },
      create: {
        sessionId: this.waSessionId,
        key,
        valueEnc: encrypt(value, this.key),
      },
      update: { valueEnc: encrypt(value, this.key) },
    });
  }

  async clear(): Promise<void> {
    await this.prisma.waAuthKey.deleteMany({
      where: { sessionId: this.waSessionId },
    });
  }
}
