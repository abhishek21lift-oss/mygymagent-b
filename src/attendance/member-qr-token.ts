import { createHash, createHmac, randomBytes } from 'crypto';
import type { ConfigService } from '@nestjs/config';

export const QR_VALIDITY_DAYS = 30;

/**
 * A member's entry QR code, readable again without being stored.
 *
 * The code is an HMAC of a random per-member nonce under a server-side
 * key. The row keeps the nonce and a sha256 of the code: the desk looks
 * the code up by that hash as before, and showing the member's current
 * code is a recompute rather than a re-mint. A database dump alone still
 * yields no working code, because the key is not in it.
 *
 * Before this, only the hash was kept, so every view had to mint a new
 * code -- and opening a member's profile at the desk silently retired the
 * code on the member's phone (or a printed card).
 */
export function qrTokenKey(config: ConfigService): Buffer {
  const secret =
    config.get<string>('QR_TOKEN_SECRET') ||
    config.getOrThrow<string>('JWT_ACCESS_SECRET');
  // Domain-separated, so the key is never the JWT secret itself.
  return createHmac('sha256', secret).update('member-qr-token/v1').digest();
}

export function qrTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function deriveQrToken(
  key: Buffer,
  memberId: string,
  nonce: string,
): string {
  return createHmac('sha256', key).update(`${memberId}:${nonce}`).digest('hex');
}

/**
 * The code a stored row stands for, or null when it can't be shown: none
 * was ever recoverable (a row from before the nonce), it is past its
 * rotation date, or the key has changed since it was issued.
 */
export function currentQrToken(
  key: Buffer,
  row: {
    memberId: string;
    tokenHash: string;
    tokenNonce: string | null;
    rotatesAt: Date;
  },
  now: number = Date.now(),
): string | null {
  if (!row.tokenNonce || row.rotatesAt.getTime() <= now) return null;
  const token = deriveQrToken(key, row.memberId, row.tokenNonce);
  return qrTokenHash(token) === row.tokenHash ? token : null;
}

export function freshQrCredential(
  key: Buffer,
  memberId: string,
  now: number = Date.now(),
) {
  const tokenNonce = randomBytes(16).toString('hex');
  const token = deriveQrToken(key, memberId, tokenNonce);
  return {
    token,
    data: {
      tokenNonce,
      tokenHash: qrTokenHash(token),
      rotatesAt: new Date(now + QR_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    },
  };
}
