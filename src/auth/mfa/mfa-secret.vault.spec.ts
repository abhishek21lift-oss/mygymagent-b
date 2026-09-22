import { randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  parseMfaVaultKey,
} from './mfa-secret.vault';

describe('mfa-secret.vault', () => {
  const keyHex = randomBytes(32).toString('hex');
  const key = parseMfaVaultKey(keyHex);

  describe('parseMfaVaultKey', () => {
    it('accepts exactly 32 bytes of hex', () => {
      expect(parseMfaVaultKey(keyHex)).toHaveLength(32);
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
      ['too short', randomBytes(16).toString('hex')],
      ['too long', randomBytes(48).toString('hex')],
      ['not hex', 'z'.repeat(64)],
    ])(
      'rejects a %s key with a 503 rather than booting insecurely',
      (_label, value) => {
        expect(() => parseMfaVaultKey(value)).toThrow(
          ServiceUnavailableException,
        );
      },
    );

    it('never puts key material in the error message', () => {
      try {
        parseMfaVaultKey('deadbeef');
        fail('expected a throw');
      } catch (error) {
        expect((error as Error).message).not.toContain('deadbeef');
      }
    });
  });

  it('round-trips a secret', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptMfaSecret(encryptMfaSecret(secret, key), key)).toBe(secret);
  });

  it('produces a different envelope every time (random iv)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const a = encryptMfaSecret(secret, key);
    const b = encryptMfaSecret(secret, key);
    expect(a).not.toBe(b);
    expect(decryptMfaSecret(a, key)).toBe(decryptMfaSecret(b, key));
  });

  it('never stores the plaintext inside the envelope', () => {
    const envelope = encryptMfaSecret('JBSWY3DPEHPK3PXP', key);
    expect(envelope).not.toContain('JBSWY3DPEHPK3PXP');
    expect(envelope.startsWith('v1.')).toBe(true);
  });

  it('refuses a different key', () => {
    const envelope = encryptMfaSecret('JBSWY3DPEHPK3PXP', key);
    const otherKey = parseMfaVaultKey(randomBytes(32).toString('hex'));
    expect(() => decryptMfaSecret(envelope, otherKey)).toThrow(
      'Failed to decrypt MFA secret',
    );
  });

  it('refuses a tampered ciphertext (GCM tag check)', () => {
    const envelope = encryptMfaSecret('JBSWY3DPEHPK3PXP', key);
    const [version, iv, tag, cipher] = envelope.split('.');
    const flipped = cipher.startsWith('a')
      ? `b${cipher.slice(1)}`
      : `a${cipher.slice(1)}`;
    expect(() =>
      decryptMfaSecret([version, iv, tag, flipped].join('.'), key),
    ).toThrow('Failed to decrypt MFA secret');
  });

  it.each([
    ['wrong part count', 'v1.aa.bb'],
    ['unknown version', 'v2.aa.bb.cc'],
  ])('rejects a malformed envelope (%s)', (_label, envelope) => {
    expect(() => decryptMfaSecret(envelope, key)).toThrow(
      'Malformed MFA secret envelope',
    );
  });
});
