import { WebhookBlockedError, assertPublicUrl } from './webhook-ssrf';

const ALLOW = process.env.WEBHOOK_ALLOW_PRIVATE_URLS;

afterEach(() => {
  if (ALLOW === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_URLS;
  else process.env.WEBHOOK_ALLOW_PRIVATE_URLS = ALLOW;
});

describe('assertPublicUrl', () => {
  it('refuses private IPs without resolving DNS', async () => {
    await expect(assertPublicUrl('http://192.168.1.5/hook')).rejects.toThrow(
      WebhookBlockedError,
    );
  });

  it('refuses non-URLs and non-http(s)', async () => {
    await expect(assertPublicUrl('not-a-url')).rejects.toThrow(
      WebhookBlockedError,
    );
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(
      WebhookBlockedError,
    );
  });

  it('passes a public IP literal', async () => {
    await expect(assertPublicUrl('https://93.184.216.34/hook')).resolves.toBe(
      'https://93.184.216.34/hook',
    );
  });

  it('honors the allowlist for loopback', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:9999/hook')).rejects.toThrow(
      WebhookBlockedError,
    );
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS = '127.0.0.1';
    await expect(assertPublicUrl('http://127.0.0.1:9999/hook')).resolves.toBe(
      'http://127.0.0.1:9999/hook',
    );
  });
});
