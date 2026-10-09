import dns from 'node:dns/promises';
import {
  WebhookBlockedError,
  assertPublicUrl,
  guardedLookup,
  isBlockedAddress,
} from './webhook-ssrf';

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

  it('refuses 0.0.0.0, which reaches the local host', async () => {
    await expect(assertPublicUrl('http://0.0.0.0:4000/')).rejects.toThrow(
      WebhookBlockedError,
    );
    await expect(assertPublicUrl('http://0/')).rejects.toThrow(
      WebhookBlockedError,
    );
  });

  it('refuses IPv6 loopback and private literals', async () => {
    for (const url of [
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(WebhookBlockedError);
    }
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.17.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('guardedLookup', () => {
  afterEach(() => jest.restoreAllMocks());

  const lookup = (host: string, all = false) =>
    new Promise<unknown>((resolve, reject) =>
      guardedLookup(host, { all }, (error, address) =>
        error ? reject(error) : resolve(address),
      ),
    );

  it('refuses a name that rebinds to a private address at connect time', async () => {
    // First answer public (what assertPublicUrl saw), then the metadata
    // address when the socket resolves it again.
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
      .mockResolvedValueOnce([
        { address: '169.254.169.254', family: 4 },
      ] as never);
    await expect(assertPublicUrl('http://rebind.example/')).resolves.toBe(
      'http://rebind.example/',
    );
    await expect(lookup('rebind.example')).rejects.toThrow(WebhookBlockedError);
  });

  it('refuses an AAAA answer for ::1', async () => {
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '::1', family: 6 }] as never);
    await expect(lookup('six.example', true)).rejects.toThrow(
      WebhookBlockedError,
    );
  });

  it('hands the socket a vetted public address', async () => {
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    await expect(lookup('public.example')).resolves.toBe('93.184.216.34');
  });
});
