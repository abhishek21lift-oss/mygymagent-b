import { AutomationCollector } from './automation.collector';
import { HttpCollector } from './http.collector';
import { HttpMetricsRing } from './http-metrics.ring';
import { MessagingCollector } from './messaging.collector';
import { TenantsCollector } from './tenants.collector';

const grouped = (rows: Record<string, unknown>[]) =>
  rows.map(({ n, ...rest }) => ({ ...rest, _count: { _all: n as number } }));

describe('MessagingCollector', () => {
  it('reports every channel, silent ones as measured zeros', async () => {
    const prisma = {
      messageLog: {
        groupBy: jest.fn().mockResolvedValue(
          grouped([
            { channel: 'EMAIL', status: 'SENT', n: 9 },
            { channel: 'EMAIL', status: 'FAILED', n: 1 },
          ]),
        ),
      },
    } as never;
    const result = await new MessagingCollector(prisma).collect();
    expect(Object.keys(result.value!.channels).sort()).toEqual([
      'EMAIL',
      'PUSH',
      'SMS',
      'WHATSAPP',
    ]);
    expect(result.value!.channels.EMAIL.failureRate).toBeCloseTo(0.1);
    expect(result.value!.channels.PUSH.failureRate).toBeNull();
    expect(result.value!.totals.total).toBe(10);
    expect(result.status).toBe('ok');
  });

  it('degrades when a channel is failing at volume', async () => {
    const prisma = {
      messageLog: {
        groupBy: jest.fn().mockResolvedValue(
          grouped([
            { channel: 'WHATSAPP', status: 'SENT', n: 4 },
            { channel: 'WHATSAPP', status: 'FAILED', n: 4 },
          ]),
        ),
      },
    } as never;
    expect((await new MessagingCollector(prisma).collect()).status).toBe(
      'degraded',
    );
  });
});

describe('AutomationCollector', () => {
  it('totals runs and ranks automations by volume', async () => {
    const prisma = {
      automationRun: {
        groupBy: jest.fn().mockResolvedValue(
          grouped([
            { key: 'LOW_STOCK_ALERT', status: 'SENT', n: 1 },
            { key: 'MEMBERSHIP_RENEWAL_REMINDER', status: 'SENT', n: 5 },
            { key: 'MEMBERSHIP_RENEWAL_REMINDER', status: 'SKIPPED', n: 3 },
          ]),
        ),
      },
    } as never;
    const result = await new AutomationCollector(prisma).collect();
    expect(result.value).toMatchObject({ sent: 6, skipped: 3, failed: 0 });
    expect(result.value!.byKey[0].key).toBe('MEMBERSHIP_RENEWAL_REMINDER');
  });
});

describe('TenantsCollector', () => {
  it('counts live organizations by state', async () => {
    const prisma = {
      organization: {
        groupBy: jest.fn().mockResolvedValue(
          grouped([
            { status: 'ACTIVE', n: 7 },
            { status: 'TRIAL', n: 3 },
          ]),
        ),
        count: jest.fn().mockResolvedValue(2),
      },
    } as never;
    const result = await new TenantsCollector(prisma).collect();
    expect(result.value).toEqual({
      total: 10,
      trial: 3,
      active: 7,
      suspended: 0,
      cancelled: 0,
      newLast7Days: 2,
    });
  });
});

describe('HttpCollector', () => {
  it('reports an empty ring as ok with null percentiles, not zeros', async () => {
    const result = await new HttpCollector(new HttpMetricsRing()).collect();
    expect(result.status).toBe('ok');
    expect(result.value!.latencyMs.p95).toBeNull();
  });

  it('degrades when server errors are a real share of traffic', async () => {
    const ring = new HttpMetricsRing();
    for (let i = 0; i < 18; i += 1)
      ring.record({ durationMs: 20, statusCode: 200 });
    for (let i = 0; i < 4; i += 1)
      ring.record({ durationMs: 20, statusCode: 503 });
    expect((await new HttpCollector(ring).collect()).status).toBe('degraded');
  });
});
