import { WhatsappCollector } from './whatsapp.collector';

describe('WhatsappCollector', () => {
  function prismaWith(overrides: {
    cloud?: { status: string; n: number }[];
    web?: { status: string; n: number }[];
    messages?: { status: string; n: number }[];
    brokenCloud?: unknown[];
    brokenWeb?: unknown[];
    cloudConnected?: string[];
    webConnected?: string[];
    counts?: number[];
  }) {
    const grouped = (rows: { status: string; n: number }[] = []) =>
      rows.map((r) => ({ status: r.status, _count: { _all: r.n } }));
    const counts = [...(overrides.counts ?? [0, 0, 0, 0])];
    const count = jest.fn(() => Promise.resolve(counts.shift() ?? 0));
    return {
      whatsappIntegration: {
        groupBy: jest.fn().mockResolvedValue(grouped(overrides.cloud)),
        findMany: jest.fn((args: { where: { status: unknown } }) =>
          Promise.resolve(
            args.where.status === 'CONNECTED'
              ? (overrides.cloudConnected ?? []).map((organizationId) => ({
                  organizationId,
                }))
              : (overrides.brokenCloud ?? []),
          ),
        ),
      },
      whatsappWebSession: {
        groupBy: jest.fn().mockResolvedValue(grouped(overrides.web)),
        count,
        findMany: jest.fn((args: { where: { status: unknown } }) =>
          Promise.resolve(
            args.where.status === 'CONNECTED'
              ? (overrides.webConnected ?? []).map((organizationId) => ({
                  organizationId,
                }))
              : (overrides.brokenWeb ?? []),
          ),
        ),
      },
      whatsappCredential: { count },
      messageLog: {
        groupBy: jest.fn().mockResolvedValue(grouped(overrides.messages)),
      },
      inboundMessage: { count },
    } as never;
  }

  it('reports nothing measured as zeros and a null rate, never a fabricated 0%', async () => {
    const result = await new WhatsappCollector(prismaWith({})).collect();
    expect(result.status).toBe('ok');
    expect(result.value?.messages.failureRate).toBeNull();
    expect(result.value?.connectedGyms).toBe(0);
    expect(result.value?.attention).toEqual([]);
  });

  it('counts a gym connected on both paths once', async () => {
    const result = await new WhatsappCollector(
      prismaWith({
        cloud: [{ status: 'CONNECTED', n: 2 }],
        web: [{ status: 'CONNECTED', n: 2 }],
        cloudConnected: ['org-a', 'org-b'],
        webConnected: ['org-b', 'org-c'],
      }),
    ).collect();
    expect(result.value?.connectedGyms).toBe(3);
    expect(result.value?.cloudApi.connected).toBe(2);
    expect(result.value?.web.connected).toBe(2);
  });

  it('computes the failure rate over settled sends only', async () => {
    const result = await new WhatsappCollector(
      prismaWith({
        messages: [
          { status: 'PENDING', n: 10 },
          { status: 'SENT', n: 6 },
          { status: 'DELIVERED', n: 2 },
          { status: 'FAILED', n: 2 },
        ],
      }),
    ).collect();
    expect(result.value?.messages.total).toBe(20);
    expect(result.value?.messages.failureRate).toBeCloseTo(0.2);
    expect(result.status).toBe('degraded');
  });

  it('lists broken links, hard errors first, and marks the card degraded', async () => {
    const at = (iso: string) => new Date(iso);
    const result = await new WhatsappCollector(
      prismaWith({
        cloud: [{ status: 'DISCONNECTED', n: 1 }],
        web: [{ status: 'LOGGED_OUT', n: 1 }],
        brokenCloud: [
          {
            organizationId: 'org-a',
            status: 'DISCONNECTED',
            lastError: null,
            updatedAt: at('2026-10-06T09:00:00Z'),
            organization: { name: 'Alpha Gym' },
          },
        ],
        brokenWeb: [
          {
            organizationId: 'org-b',
            status: 'LOGGED_OUT',
            lastError: 'x'.repeat(400),
            disconnectedAt: at('2026-10-05T09:00:00Z'),
            updatedAt: at('2026-10-05T09:00:00Z'),
            organization: { name: 'Beta Gym' },
          },
        ],
      }),
    ).collect();
    expect(result.status).toBe('degraded');
    expect(result.value?.attention.map((r) => r.organizationName)).toEqual([
      'Beta Gym',
      'Alpha Gym',
    ]);
    expect(result.value?.attention[0].lastError?.length).toBeLessThanOrEqual(
      160,
    );
  });
});
