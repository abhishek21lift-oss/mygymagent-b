import { WaAkgProvider, sessionIdFor, toJid } from './wa-akg.provider';

const india = { currency: 'INR', timezone: 'Asia/Kolkata' };
const elsewhere = { currency: 'USD', timezone: 'America/New_York' };

function provider(env: Record<string, string | undefined> = {}) {
  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback ?? undefined,
  };
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue(india) },
  };
  const sender = {
    enqueue: jest.fn(async () => ({
      queued: true,
      providerMessageId: 'waakg:queued:log-1',
    })),
  };
  return {
    provider: new WaAkgProvider(
      config as never,
      prisma as never,
      sender as never,
    ),
    prisma,
    sender,
  };
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
    expect(toJid('+1 (415) 555-0100', india)).toBe(
      '14155550100@s.whatsapp.net',
    );
  });

  it('refuses a local number for a non-Indian gym instead of guessing', () => {
    expect(() => toJid('4155550100', elsewhere)).toThrow(/country code/);
  });

  it('refuses numbers that are too short', () => {
    expect(() => toJid('12345', india)).toThrow();
  });
});

describe('WaAkgProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is not configured without the session vault key', () => {
    const { provider: p } = provider({});
    expect(p.isConfigured()).toBe(false);
  });

  it('enqueues normalized text on the linked number', async () => {
    const { provider: p, sender } = provider({ WA_AUTH_KEY: 'ab'.repeat(32) });

    const result = await p.send({
      to: '98765 43210',
      text: 'Hello',
      organizationId: 'org_123',
      messageLogId: 'log-1',
    });

    expect(result).toEqual({
      queued: true,
      providerMessageId: 'waakg:queued:log-1',
    });
    expect(sender.enqueue).toHaveBeenCalledWith({
      organizationId: 'org_123',
      to: '919876543210@s.whatsapp.net',
      text: 'Hello',
      category: undefined,
      messageLogId: 'log-1',
    });
  });

  it('throws ServiceUnavailable when unconfigured instead of sending', async () => {
    const { provider: p } = provider({});
    await expect(
      p.send({ to: '+919876543210', text: 'Hi', organizationId: 'org_123' }),
    ).rejects.toThrow(/isn't configured/);
  });
});
