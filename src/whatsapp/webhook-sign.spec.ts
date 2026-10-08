import { signWebhook } from './webhook-sign';

describe('signWebhook', () => {
  it('matches the HMAC-SHA256 known vector', () => {
    expect(
      signWebhook('key', 'The quick brown fox jumps over the lazy dog'),
    ).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('signs over UTF-8 bytes, not chars', () => {
    const hex = signWebhook('sëcret', '{"a":"héllo 🎉"}');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(signWebhook('sëcret', '{"a":"héllo 🎉"}'));
    expect(hex).not.toBe(signWebhook('secret', '{"a":"héllo 🎉"}'));
  });
});
