import 'reflect-metadata';
import { OperationsIntelligenceService } from './operations-intelligence.service';

const DAY = 24 * 60 * 60 * 1000;

function session(
  id: string,
  programId: string,
  programName: string,
  capacity: number | null,
  booked: number,
  waitlisted: number,
  startOffsetDays: number,
  instructorId: string | null = null,
) {
  const startTime = new Date(Date.now() + startOffsetDays * DAY);
  return {
    id,
    capacity,
    startTime,
    endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
    instructorId,
    classProgram: { id: programId, name: programName, capacity },
    bookings: [
      ...Array.from({ length: booked }, () => ({ status: 'BOOKED' })),
      ...Array.from({ length: waitlisted }, () => ({ status: 'WAITLISTED' })),
    ],
  };
}

describe('OperationsIntelligenceService.getClassCapacity', () => {
  it('bands sessions and averages program demand honestly', async () => {
    const prisma = {
      classSession: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            session('s-full', 'p1', 'Yoga', 20, 20, 3, 1),
            session('s-half', 'p1', 'Yoga', 20, 8, 0, 2),
            session('s-nocap', 'p2', 'Spin', null, 5, 0, 3),
          ])
          .mockResolvedValueOnce([
            session('s-old1', 'p1', 'Yoga', 20, 18, 0, -10),
            session('s-old2', 'p1', 'Yoga', 20, 10, 0, -20),
          ]),
      },
    };
    const service = new OperationsIntelligenceService(prisma as never);
    const result = await service.getClassCapacity('org-1', null);
    expect(result.upcoming.find((s) => s.sessionId === 's-full')).toMatchObject(
      {
        utilizationPct: 100,
        band: 'OVERBOOKED_RISK',
        booked: 20,
        waitlisted: 3,
      },
    );
    expect(result.upcoming.find((s) => s.sessionId === 's-half')?.band).toBe(
      'HEALTHY',
    );
    expect(
      result.upcoming.find((s) => s.sessionId === 's-nocap'),
    ).toMatchObject({ utilizationPct: null, band: 'UNKNOWN' });
    // (18 + 10) / 2 / 20 = 70%.
    expect(result.demand.find((d) => d.programId === 'p1')).toMatchObject({
      avgUtilizationPct: 70,
      sessionsCount: 2,
    });
  });
});

describe('OperationsIntelligenceService.getSchedulingConflicts', () => {
  it('flags only true instructor overlaps across systems', async () => {
    const base = Date.now() + DAY;
    const prisma = {
      classSession: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'c1',
            startTime: new Date(base),
            endTime: new Date(base + 3600000),
            instructorId: 'u1',
            classProgram: { name: 'Yoga' },
            instructor: { id: 'u1', firstName: 'T', lastName: 'R' },
          },
          {
            id: 'c2',
            startTime: new Date(base + 7200000),
            endTime: new Date(base + 10800000),
            instructorId: 'u1',
            classProgram: { name: 'Spin' },
            instructor: { id: 'u1', firstName: 'T', lastName: 'R' },
          },
        ]),
      },
      ptSession: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'pt1',
            trainerId: 'prof-1',
            startTime: new Date(base + 1800000),
            endTime: new Date(base + 5400000),
          },
        ]),
      },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      staffProfile: {
        findMany: jest.fn().mockResolvedValue([{ id: 'prof-1', userId: 'u1' }]),
      },
    };
    const service = new OperationsIntelligenceService(prisma as never);
    const conflicts = await service.getSchedulingConflicts('org-1', null);
    // c1 overlaps pt1 (same trainer via profile map); c2 is clear.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ userId: 'u1', name: 'T R' });
    expect(conflicts[0].items.map((i) => i.id).sort()).toEqual(['c1', 'pt1']);
  });
});

describe('OperationsIntelligenceService.getOperationsHealth', () => {
  it('scores real dimensions and reports gaps as unknown', async () => {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
      classSession: { findMany: jest.fn().mockResolvedValue([]) },
      ptSession: { findMany: jest.fn().mockResolvedValue([]) },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      staffProfile: { findMany: jest.fn().mockResolvedValue([]) },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      leaveRequest: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new OperationsIntelligenceService(prisma as never);
    const health = await service.getOperationsHealth('org-1', null);
    // No sessions, no gate traffic, no products: classes/attendance/
    // inventory unknown; scheduling clean at 100; gaps explicit.
    expect(health.score).toBe(100);
    expect(health.status).toBe('healthy');
    expect(health.components.find((c) => c.key === 'tasks')).toMatchObject({
      score: null,
    });
    expect(health.components.find((c) => c.key === 'equipment')).toMatchObject({
      score: null,
    });
    expect(health.components).toHaveLength(9);
  });
});
