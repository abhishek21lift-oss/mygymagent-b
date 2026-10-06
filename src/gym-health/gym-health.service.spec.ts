import { Test } from '@nestjs/testing';
import { GymHealthService } from './gym-health.service';
import { computeHealthScore, healthStatus } from './gym-health.score';
import { FinanceService } from '../analytics/finance.service';
import { InventoryIntelligenceService } from '../analytics/inventory-intelligence.service';
import { MemberIntelligenceService } from '../analytics/member-intelligence.service';
import { SalesIntelligenceService } from '../analytics/sales-intelligence.service';
import { IntelligenceAnalyticsService } from '../member-intelligence/intelligence-analytics.service';

describe('computeHealthScore', () => {
  const full = {
    gross: 100000,
    net: 92000,
    outstanding: 8000,
    activeMembers: 100,
    atRiskMembers: 10,
    totalLeads: 40,
    conversionRatePct: 25,
    totalProducts: 20,
    lowStockProducts: 2,
  };

  it('weights the five components into one score', () => {
    const { score, opportunity, components } = computeHealthScore(full);
    // revenue 92*.3 + collections ~92.6*.25 → 81.6 rounds to 82 + retention 90*.2 + sales 25*.15 + inventory 90*.1
    expect(score).toBe(82);
    expect(opportunity).toBe('sales');
    expect(components).toHaveLength(5);
  });

  it('returns nulls, never zeros, without data', () => {
    const empty = {
      gross: 0,
      net: 0,
      outstanding: 0,
      activeMembers: 0,
      atRiskMembers: 0,
      totalLeads: 0,
      conversionRatePct: 0,
      totalProducts: 0,
      lowStockProducts: 0,
    };
    const { score, opportunity, components } = computeHealthScore(empty);
    expect(score).toBeNull();
    expect(opportunity).toBeNull();
    expect(components.every((c) => c.score === null)).toBe(true);
  });

  it('renormalizes over whatever is available', () => {
    const { score } = computeHealthScore({
      ...full,
      gross: 0,
      net: 0,
      outstanding: 0,
      totalLeads: 0,
      totalProducts: 0,
    });
    // retention 90 (w20) only
    expect(score).toBe(90);
  });

  it('clamps pathological ratios into 0–100', () => {
    const { components } = computeHealthScore({
      ...full,
      net: -5000,
      outstanding: 999999,
    });
    for (const c of components) {
      if (c.score !== null) {
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('healthStatus', () => {
  it('bands scores and names the unknown', () => {
    expect(healthStatus(null)).toBe('unknown');
    expect(healthStatus(82)).toBe('healthy');
    expect(healthStatus(65)).toBe('stable');
    expect(healthStatus(45)).toBe('needs-attention');
    expect(healthStatus(10)).toBe('critical');
  });
});

describe('GymHealthService', () => {
  it('aggregates the existing services without new queries of its own', async () => {
    const finance = {
      getRevenueSummary: jest.fn().mockResolvedValue({
        revenue: [
          {
            currency: 'INR',
            grossRevenue: '100000.00',
            netRevenue: '92000.00',
          },
        ],
        outstanding: [{ currency: 'INR', outstandingBalance: '8000.00' }],
      }),
    };
    const members = {
      getStatusBreakdown: jest
        .fn()
        .mockResolvedValue([{ status: 'ACTIVE', count: 100 }]),
      getAtRiskMembers: jest.fn().mockResolvedValue(new Array(10).fill({})),
    };
    const sales = {
      getFunnel: jest
        .fn()
        .mockResolvedValue({ totalLeads: 40, conversionRatePct: '25.00' }),
    };
    const inventory = {
      getStockForecast: jest.fn().mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          atOrBelowReorderLevel: i < 2,
        })),
      ),
    };
    const risk = {
      getRevenueAtRisk: jest.fn().mockResolvedValue({
        totalMRR: 100,
        atRiskMRR: 10,
        atRiskPercentage: 10,
        bySegment: [],
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GymHealthService,
        { provide: FinanceService, useValue: finance },
        { provide: MemberIntelligenceService, useValue: members },
        { provide: SalesIntelligenceService, useValue: sales },
        { provide: InventoryIntelligenceService, useValue: inventory },
        { provide: IntelligenceAnalyticsService, useValue: risk },
      ],
    }).compile();
    const service = moduleRef.get(GymHealthService);
    const health = await service.getHealth('org-1', null);
    expect(health.score).toBe(82);
    expect(health.status).toBe('healthy');
    expect(health.opportunity).toBe('sales');
    expect(health.revenueAtRisk.atRiskMRR).toBe(10);
    expect(health.branchId).toBeNull();
    expect(health.mixedCurrencies).toBe(false);
    expect(typeof health.computedAt).toBe('string');
  });
});
