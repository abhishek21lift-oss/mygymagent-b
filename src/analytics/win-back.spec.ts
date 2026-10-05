import 'reflect-metadata';
import { MemberIntelligenceService } from './member-intelligence.service';

const DAY = 24 * 60 * 60 * 1000;

function lapsedMember(id: string, endedDaysAgo: number) {
  const now = Date.now();
  return {
    id,
    firstName: 'Ex',
    lastName: id,
    status: 'ACTIVE',
    memberships: [
      {
        status: 'EXPIRED',
        startDate: new Date(now - (endedDaysAgo + 100) * DAY),
        endDate: new Date(now - endedDaysAgo * DAY),
      },
    ],
    riskProfile: null,
  };
}

describe('MemberIntelligenceService.getWinBackCandidates', () => {
  it('ranks lapsed members by proven value with evidence', async () => {
    const prisma = {
      member: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            lapsedMember('rich', 60),
            lapsedMember('poor', 90),
            lapsedMember('recent', 10),
          ]),
      },
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            memberId: 'rich',
            amount: '45000',
            currency: 'INR',
            createdAt: new Date(),
          },
          {
            memberId: 'poor',
            amount: '2000',
            currency: 'INR',
            createdAt: new Date(),
          },
        ]),
      },
      attendance: {
        groupBy: jest.fn().mockResolvedValue([
          {
            memberId: 'rich',
            _max: { checkInAt: new Date(Date.now() - 70 * DAY) },
          },
        ]),
      },
      ptPackage: {
        groupBy: jest.fn().mockResolvedValue([{ memberId: 'rich', _count: 2 }]),
      },
    };
    const service = new MemberIntelligenceService(prisma as never);
    const result = await service.getWinBackCandidates('org-1', null);
    // recent churn (< 30d) belongs to renewals, not win-back.
    expect(result.items.map((i) => i.memberId)).toEqual(['rich', 'poor']);
    expect(result.items[0]).toMatchObject({ tier: 'HIGH' });
    expect(result.items[0].reasons.join(' ')).toMatch(/45,000/);
    expect(result.items[0].reasons.join(' ')).toMatch(/2 prior PT packages/);
    expect(result.items[0].daysSinceExpiry).toBe(60);
    expect(result.counts.high).toBe(1);
  });

  it('returns empty when nobody lapsed', async () => {
    const prisma = {
      member: { findMany: jest.fn().mockResolvedValue([]) },
      payment: { findMany: jest.fn() },
      attendance: { groupBy: jest.fn() },
      ptPackage: { groupBy: jest.fn() },
    };
    const service = new MemberIntelligenceService(prisma as never);
    const result = await service.getWinBackCandidates('org-1', null);
    expect(result).toEqual({
      items: [],
      counts: { high: 0, medium: 0, low: 0 },
    });
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});
