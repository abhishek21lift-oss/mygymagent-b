import 'reflect-metadata';
import { TrainerIntelligenceService } from './trainer-intelligence.service';

const DAY = 24 * 60 * 60 * 1000;

function pkg(
  id: string,
  memberId: string,
  totalSessions: number,
  usedSessions: number,
  endOffsetDays: number,
  startOffsetDays: number,
) {
  const now = Date.now();
  return {
    id,
    name: 'PT-10',
    totalSessions,
    usedSessions,
    endDate: new Date(now + endOffsetDays * DAY),
    startDate: new Date(now + startOffsetDays * DAY),
    member: { id: memberId, firstName: 'A', lastName: 'B' },
  };
}

describe('TrainerIntelligenceService.getPtOpportunities', () => {
  it('flags expiring-with-sessions and never-started packages', async () => {
    const prisma = {
      ptPackage: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            pkg('expiring', 'm1', 10, 4, 5, -60),
            pkg('used-up', 'm2', 10, 10, 3, -60),
          ])
          .mockResolvedValueOnce([pkg('dormant', 'm3', 12, 0, 90, -30)]),
        count: jest
          .fn()
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1),
      },
    };
    const service = new TrainerIntelligenceService(prisma as never);
    const result = await service.getPtOpportunities('org-1', null);
    // used-up has nothing left -> excluded from expiring.
    expect(result.expiring.map((o) => o.packageId)).toEqual(['expiring']);
    expect(result.expiring[0]).toMatchObject({
      sessionsRemaining: 6,
      daysLeft: 5,
      reason: 'EXPIRING_WITH_SESSIONS',
    });
    expect(result.neverStarted.map((o) => o.packageId)).toEqual(['dormant']);
    expect(result.neverStarted[0].reason).toBe('NEVER_STARTED');
    expect(result.counts).toEqual({
      expiring: 1,
      neverStarted: 1,
      activePackages: 3,
    });
  });
});
