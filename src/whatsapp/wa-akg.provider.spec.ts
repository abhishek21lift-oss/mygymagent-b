import { WaAkgProvider, sessionIdFor, toJid } from './wa-akg.provider';

const india = { currency: 'INR', timezone: 'Asia/Kolkata' };
const elsewhere = { currency: 'USD', timezone: 'America/New_York' };

function provider(env: Record<string, string | undefined> = {}) {
  const config = {
    get: (key: string, fallback?: string) =>
      env[key] ?? fallback ?? undefined,
  };
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue(india) },
  };
  return { provider: new WaAkgProvider(config as never, prisma as never), prisma };
}

describe('sessionIdFor', () => {
  it('maps an org to its deterministic WA-AKG session', () => {
    expect(sessionIdFor('org_123')).toBe('gym-org_123');
  });
});

describe('toJid', () => {
  it('gives an Indian gym local number +91', () => {
    expect(toJid('98765 43210', india)).toBe('919876543210@s.whatsapp.net');
  });

  it('strips the trunk 0 for an Indian gym', () => {
    expect(toJid('098765-43210', india)).toBe('919876543210@s.whatsapp.net');
  });

  it('keeps an explicit country code untouched', () => {
    expect(toJid('+1 (415) 555-0100', india)).toBe('14155550100@s.whatsapp.net');
  });

  it('refuses a local number for a non-Indian gym instead of guessing', () => {
    expect(() => toJid('4155550100', elsewhere)).toThrow(/country code/);
  });

  it('refuses numbers that are too short', () => {
    expect(() => toJid('12345', india)).toThrow();
  });
});

describe('WaAkgProvider', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('is not configured without base URL and API key', () => {
    const { provider: p } = provider({});
    expect(p.isConfigured()).toBe(false);
  });

  it('sends text through the org session and returns the waakg id', async () => {
    const { provider: p } = provider({
      WA_AKG_BASE_URL: 'http://wa-akg:3000',
      WA_AKG_API_KEY: 'wag_test',
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: { key: { id: 'ABC' } },
      }),
    });
    global.fetch = fetchMock as never;

    const id = await p.send({
      to: '98765 43210',
      text: 'Hello',
      organizationId: 'org_123',
    });

    expect(id).toBe('waakg:ABC');
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(
      'http://wa-akg:3000/api/messages/gym-org_123/919876543210%40s.whatsapp.net/send',
    );
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('wag_test');
    expect(JSON.parse(init.body as string)).toEqual({ message: { text: 'Hello' } });
  });

  it('throws ServiceUnavailable when unconfigured instead of sending', async () => {
    const { provider: p } = provider({});
    await expect(
      p.send({ to: '+919876543210', text: 'Hi', organizationId: 'org_123' }),
    ).rejects.toThrow(/isn't configured/);
  });
});
