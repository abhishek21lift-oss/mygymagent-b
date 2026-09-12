import { randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  decryptWhatsappToken,
  encryptWhatsappToken,
  parseWhatsappVaultKey,
} from './whatsapp-token.vault';

describe('whatsapp-token.vault', () => {
  const keyHex = randomBytes(32).toString('hex');
  const key = parseWhatsappVaultKey(keyHex);

  it('round-trips a token through encrypt/decrypt', () => {
    const enc = encryptWhatsappToken('EAAMetaSystemUserToken123', key);
    expect(enc).not.toContain('EAAMetaSystemUserToken123');
    expect(decryptWhatsappToken(enc, key)).toBe('EAAMetaSystemUserToken123');
  });

  it('produces a fresh envelope per encryption (random iv)', () => {
    expect(encryptWhatsappToken('tok', key)).not.toBe(
      encryptWhatsappToken('tok', key),
    );
  });

  it.each([undefined, '', 'short', 'zz'.repeat(32), 'ab'.repeat(31)])(
    'rejects an invalid vault key (%p) with 503',
    (bad) => {
      expect(() => parseWhatsappVaultKey(bad as string)).toThrow(
        ServiceUnavailableException,
      );
      expect(() => parseWhatsappVaultKey(bad as string)).toThrow(
        "WhatsApp sending isn't configured",
      );
    },
  );

  it('fails decrypt on a wrong key or tampered envelope without leaking material', () => {
    const enc = encryptWhatsappToken('secret-token', key);
    const otherKey = parseWhatsappVaultKey(randomBytes(32).toString('hex'));
    // Flip the first ciphertext hex digit deterministically (toggling
    // between two values guarantees the envelope actually changes, unlike
    // overwriting a suffix that might already equal the new text).
    const parts = enc.split('.');
    const first = parts[3][0];
    parts[3] = (first === '0' ? '1' : '0') + parts[3].slice(1);
    const tampered = parts.join('.');
    expect(tampered).not.toBe(enc);
    for (const bad of [tampered, 'v9' + enc.slice(2), 'junk']) {
      expect(() => decryptWhatsappToken(bad, key)).toThrow();
    }
    expect(() => decryptWhatsappToken(enc, otherKey)).toThrow();
  });
});
