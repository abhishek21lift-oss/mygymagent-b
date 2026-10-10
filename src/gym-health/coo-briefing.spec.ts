import 'reflect-metadata';
import { CooBriefingService } from './coo-briefing.service';

function figures(
  date: string,
  money: { collected: number; net: number; currency?: string },
  checkIns: number,
  currencies: string[] = ['INR'],
) {
  return {
    date,
    timezone: 'Asia/Kolkata',
    checkIns,
    deniedCheckIns: 0,
    currency: money.currency ?? 'INR',
    currencies,
    collected: money.collected,
    net: money.net,
    paymentCount: 0,
    newMembers: 0,
    renewals: 0,
    leads: 0,
  };
}

/** Today then yesterday, as TodayFiguresService reports them. */
function todayFigures(today: unknown, yesterday: unknown) {
  return {
    gymDay: jest.fn().mockResolvedValue('2026-10-07'),
    forDay: jest
      .fn()
      .mockResolvedValueOnce(today)
      .mockResolvedValueOnce(yesterday),
  };
}

describe('CooBriefingService.getBriefing', () => {
  it('composes health, today, deltas, outcomes and usage without new math of its own', async () => {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
      attendance: {
        count: jest.fn().mockResolvedValueOnce(12).mockResolvedValueOnce(10),
      },
      aiUsageLog: {
        aggregate: jest.fn().mockResolvedValue({
          _count: 9,
          _sum: { totalTokens: 1200, costUsd: 0.02 },
        }),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const health = {
      getHealth: jest.fn().mockResolvedValue({
        score: 82,
        status: 'healthy',
        opportunity: 'collections',
        components: [],
        branchId: null,
        computedAt: new Date().toISOString(),
        revenueAtRisk: {},
      }),
    };
    const finance = todayFigures(
      figures('2026-10-08', { collected: 8000, net: 7500 }, 12),
      figures('2026-10-07', { collected: 4000, net: 4000 }, 10),
    );
    const aiActions = {
      countPending: jest.fn().mockResolvedValue(2),
      effectiveness: jest.fn().mockResolvedValue({
        total: 8,
        pending: 2,
        approved: 0,
        executed: 5,
        rejected: 1,
        failed: 0,
        acceptanceRate: 83.3,
        executionRate: 100,
      }),
    };
    const service = new CooBriefingService(
      prisma as never,
      health as never,
      finance as never,
      aiActions as never,
    );
    const briefing = await service.getBriefing('org-1', null);
    expect(briefing.health.score).toBe(82);
    expect(briefing.today.checkIns).toBe(12);
    // (7500-4000)/4000 = 87.5%; (12-10)/10 = 20%.
    expect(briefing.deltas).toMatchObject({
      revenueNetPct: 87.5,
      collectedPct: 100,
      checkinsPct: 20,
    });
    expect(briefing.outcomes).toEqual({ pending: 2, executed: 5, rejected: 1 });
    expect(briefing.usage).toMatchObject({ requests24h: 9, tokens24h: 1200 });
    expect(briefing.branchId).toBeNull();
    expect(briefing.today).toMatchObject({
      currency: 'INR',
      currencies: ['INR'],
      mixed: false,
    });
  });

  it('returns null deltas instead of ratios off zero', async () => {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
      attendance: {
        count: jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0),
      },
      aiUsageLog: {
        aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: {} }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const health = {
      getHealth: jest.fn().mockResolvedValue({
        score: null,
        status: 'unknown',
        opportunity: null,
        components: [],
        branchId: null,
        computedAt: new Date().toISOString(),
        revenueAtRisk: {},
      }),
    };
    const finance = todayFigures(
      figures('2026-10-08', { collected: 0, net: 0 }, 0, []),
      figures('2026-10-07', { collected: 0, net: 0 }, 0, []),
    );
    const aiActions = {
      countPending: jest.fn().mockResolvedValue(0),
      effectiveness: jest.fn().mockResolvedValue({
        total: 0,
        pending: 0,
        approved: 0,
        executed: 0,
        rejected: 0,
        failed: 0,
        acceptanceRate: null,
        executionRate: null,
      }),
    };
    const service = new CooBriefingService(
      prisma as never,
      health as never,
      finance as never,
      aiActions as never,
    );
    const briefing = await service.getBriefing('org-1', null);
    expect(briefing.deltas).toEqual({
      revenueNetPct: null,
      collectedPct: null,
      checkinsPct: null,
    });
  });

  it("flags mixed currencies and reports the gym's own, never a blend", async () => {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      aiUsageLog: {
        aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: {} }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const health = {
      getHealth: jest.fn().mockResolvedValue({
        score: 80,
        status: 'healthy',
        opportunity: null,
        components: [],
        branchId: null,
        computedAt: new Date().toISOString(),
        mixedCurrencies: true,
        revenueAtRisk: {},
      }),
    };
    const finance = todayFigures(
      figures('2026-10-08', { collected: 8000, net: 7500 }, 0, ['INR', 'USD']),
      figures('2026-10-07', { collected: 0, net: 0 }, 0, []),
    );
    const aiActions = {
      countPending: jest.fn().mockResolvedValue(0),
      effectiveness: jest.fn().mockResolvedValue({
        total: 0,
        pending: 0,
        approved: 0,
        executed: 0,
        rejected: 0,
        failed: 0,
        acceptanceRate: null,
        executionRate: null,
      }),
    };
    const service = new CooBriefingService(
      prisma as never,
      health as never,
      finance as never,
      aiActions as never,
    );
    const briefing = await service.getBriefing('org-1', null);
    expect(briefing.today.mixed).toBe(true);
    expect(briefing.today.currencies).toEqual(['INR', 'USD']);
    // The gym's currency (INR) only — 8000, not 13000.
    expect(briefing.today.collected).toBe('8000.00');
    expect(briefing.today.currency).toBe('INR');
  });

  it("asks for the gym's today and yesterday, not the UTC date", async () => {
    const figuresService = todayFigures(
      figures('2026-10-08', { collected: 0, net: 0 }, 3),
      figures('2026-10-07', { collected: 0, net: 0 }, 1),
    );
    const service = new CooBriefingService(
      {
        aiUsageLog: {
          aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: {} }),
          count: jest.fn().mockResolvedValue(0),
        },
      } as never,
      { getHealth: jest.fn().mockResolvedValue({ score: null }) } as never,
      figuresService as never,
      {
        countPending: jest.fn().mockResolvedValue(0),
        effectiveness: jest
          .fn()
          .mockResolvedValue({ executed: 0, rejected: 0 }),
      } as never,
    );
    const briefing = await service.getBriefing('org-1', 'branch-1');
    expect(figuresService.gymDay).toHaveBeenCalledWith('org-1', 1);
    expect(figuresService.forDay).toHaveBeenCalledWith(
      'org-1',
      'branch-1',
      undefined,
      expect.any(Map),
    );
    expect(figuresService.forDay).toHaveBeenCalledWith(
      'org-1',
      'branch-1',
      '2026-10-07',
      expect.any(Map),
    );
    expect(briefing.today).toMatchObject({ date: '2026-10-08', checkIns: 3 });
    expect(briefing.deltas.checkinsPct).toBe(200);
  });
});
