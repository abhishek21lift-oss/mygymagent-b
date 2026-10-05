import 'reflect-metadata';
import { MemberIntelligenceService } from './member-intelligence.service';

const DAY = 24 * 60 * 60 * 1000;

function serviceWith(
  outcomeGroups: { status: string; _count: number }[],
  visits: Date[],
  activity = { workouts: 4, visits: 6 },
) {
  const prisma = {
    member: {
      findFirst: jest.fn().mockResolvedValue({ id: 'mem-1' }),
    },
    ptSession: {
      groupBy: jest.fn().mockResolvedValue(outcomeGroups),
    },
    workoutSession: {
      count: jest.fn().mockResolvedValue(activity.workouts),
    },
    attendance: {
      count: jest.fn().mockResolvedValue(activity.visits),
      findMany: jest
        .fn()
        .mockResolvedValue(visits.map((checkInAt) => ({ checkInAt }))),
    },
  };
  return { prisma, service: new MemberIntelligenceService(prisma as never) };
}

describe('MemberIntelligenceService.getPtAdherence', () => {
  it('computes completion rate, counts and streak from records', async () => {
    const now = Date.now();
    const { prisma, service } = serviceWith(
      [
        { status: 'COMPLETED', _count: 3 },
        { status: 'CANCELLED', _count: 1 },
      ],
      [0, 3, 10].map((ago) => new Date(now - ago * DAY)),
    );
    const result = await service.getPtAdherence('org-1', 'mem-1', null, null);
    expect(result).toMatchObject({
      memberId: 'mem-1',
      windowDays: 30,
      ptAdherencePct: 75,
      workoutsCompleted30d: 4,
      visits30d: 6,
      insufficientData: false,
    });
    expect(result.weeklyStreak).toBeGreaterThanOrEqual(1);
    expect(prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'mem-1' }),
      }),
    );
  });

  it('returns null percentage under 3 decided sessions', async () => {
    const { service } = serviceWith([{ status: 'COMPLETED', _count: 1 }], [], {
      workouts: 0,
      visits: 0,
    });
    const result = await service.getPtAdherence('org-1', 'mem-1', null, null);
    expect(result.ptAdherencePct).toBeNull();
    expect(result.insufficientData).toBe(true);
  });

  it('404s members outside the caller scope', async () => {
    const prisma = {
      member: { findFirst: jest.fn().mockResolvedValue(null) },
      ptSession: { groupBy: jest.fn() },
      workoutSession: { count: jest.fn() },
      attendance: { count: jest.fn(), findMany: jest.fn() },
    };
    const service = new MemberIntelligenceService(prisma as never);
    await expect(
      service.getPtAdherence('org-1', 'foreign', 'br-1', null),
    ).rejects.toThrow('Member not found');
    expect(prisma.ptSession.groupBy).not.toHaveBeenCalled();
  });
});
