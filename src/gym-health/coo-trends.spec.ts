import 'reflect-metadata';
import { CooTrendsService } from './coo-trends.service';

function monthRow(month: string, net: string) {
  return {
    month,
    revenue: [
      { currency: 'INR', grossRevenue: net, refunded: '0.00', netRevenue: net },
    ],
  };
}

describe('CooTrendsService.getTrends', () => {
  // Month keys are computed relative to "now" so the partial current
  // month is always the newest entry, whatever day this runs.
  function monthKey(offsetMonths: number): string {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offsetMonths);
    return d.toISOString().slice(0, 7);
  }

  it('compares the last two complete months and skips the partial one', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ currency: 'INR' }),
        findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }),
      },
    };
    const finance = {
      getRevenueTrend: jest
        .fn()
        .mockResolvedValue([
          monthRow(monthKey(-3), '90000.00'),
          monthRow(monthKey(-2), '99000.00'),
          monthRow(monthKey(0), '1000.00'),
        ]),
    };
    const risk = {
      getRiskTrend: jest.fn().mockResolvedValue([
        {
          date: '2026-09-01',
          avgScore: 40,
          highRiskCount: 5,
          criticalRiskCount: 1,
        },
        {
          date: '2026-10-06',
          avgScore: 45,
          highRiskCount: 7,
          criticalRiskCount: 2,
        },
      ]),
    };
    const service = new CooTrendsService(
      prisma as never,
      finance as never,
      risk as never,
    );
    const result = await service.getTrends('org-1', null);
    const revenue = result.trends.find((t) => t.metric === 'revenue')!;
    expect(revenue).toMatchObject({
      current: 99000,
      previous: 90000,
      deltaPct: 10,
      direction: 'up',
      currency: 'INR',
      insufficientData: false,
    });
    const memberRisk = result.trends.find((t) => t.metric === 'risk')!;
    expect(memberRisk.direction).toBe('up');
    expect(memberRisk.deltaPct).toBeNull();
  });

  it('reports insufficient data instead of a trend off one month', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ currency: 'INR' }),
        findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }),
      },
    };
    const finance = {
      getRevenueTrend: jest
        .fn()
        .mockResolvedValue([monthRow(monthKey(0), '1000.00')]),
    };
    const risk = { getRiskTrend: jest.fn().mockResolvedValue([]) };
    const service = new CooTrendsService(
      prisma as never,
      finance as never,
      risk as never,
    );
    const result = await service.getTrends('org-1', null);
    expect(result.trends).toEqual([]);
  });
});

describe('CooTrendsService.getForecast', () => {
  function monthKey(offsetMonths: number): string {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offsetMonths);
    return d.toISOString().slice(0, 7);
  }

  it('bands the moving average with min-max and grades confidence by history', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ currency: 'INR' }),
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
    };
    const finance = {
      getRevenueTrend: jest
        .fn()
        .mockResolvedValue([
          monthRow(monthKey(-5), '80000.00'),
          monthRow(monthKey(-4), '90000.00'),
          monthRow(monthKey(-3), '100000.00'),
          monthRow(monthKey(-2), '90000.00'),
          monthRow(monthKey(0), '1000.00'),
        ]),
    };
    const risk = { getRiskTrend: jest.fn().mockResolvedValue([]) };
    const service = new CooTrendsService(
      prisma as never,
      finance as never,
      risk as never,
    );
    const result = await service.getForecast('org-1', null);
    expect(result.insufficientData).toBe(false);
    // avg(80k, 90k, 100k, 90k) = 90k; band 80k–100k; 4 points → moderate.
    expect(result.revenueNextMonth).toMatchObject({
      low: '80000.00',
      high: '100000.00',
      point: '90000.00',
      currency: 'INR',
      basedOnMonths: 4,
      confidence: 'moderate',
    });
  });

  it('declines to forecast under 3 complete months', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ currency: 'INR' }),
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
    };
    const finance = {
      getRevenueTrend: jest
        .fn()
        .mockResolvedValue([
          monthRow(monthKey(-1), '50000.00'),
          monthRow(monthKey(0), '1000.00'),
        ]),
    };
    const risk = { getRiskTrend: jest.fn().mockResolvedValue([]) };
    const service = new CooTrendsService(
      prisma as never,
      finance as never,
      risk as never,
    );
    const result = await service.getForecast('org-1', null);
    expect(result).toMatchObject({
      revenueNextMonth: null,
      insufficientData: true,
    });
  });
});
