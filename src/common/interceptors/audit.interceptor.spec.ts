import { sanitize } from './audit.interceptor';

describe('audit sanitize', () => {
  it('drops credentials at any depth', () => {
    const out = sanitize({
      secret: 'S',
      otpauthUri: 'otpauth://totp/x',
      recoveryCodes: ['a-b'],
      webhook: { id: 'w1', url: 'https://x', secret: 'S' },
      members: [{ id: 'm1', token: 'T' }],
      pairingCode: 'P',
      qrDataUrl: 'data:',
    });
    expect(out).toEqual({
      webhook: { id: 'w1', url: 'https://x' },
      members: [{ id: 'm1' }],
    });
  });

  it('drops the fields an endpoint names, and only those', () => {
    expect(sanitize({ id: 'd1', name: 'Door', key: 'K' }, ['key'])).toEqual({
      id: 'd1',
      name: 'Door',
    });
    expect(sanitize({ key: 'ORG_ADMIN' })).toEqual({ key: 'ORG_ADMIN' });
  });
});
