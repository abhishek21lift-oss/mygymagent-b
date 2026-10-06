import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkoutSessionsService } from './workout-sessions.service';

describe('WorkoutSessionsService.listToday', () => {
  const findMany = jest.fn();
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
    },
    workoutSession: { findMany },
  } as unknown as PrismaService;
  const service = new WorkoutSessionsService(prisma, {} as EventEmitter2);

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  function where() {
    return (findMany.mock.calls[0][0] as { where: Record<string, unknown> })
      .where;
  }

  it("bounds today by the gym's calendar day, not the server's", async () => {
    // 02:00 IST on 6 Oct is still 5 Oct in UTC.
    jest.setSystemTime(new Date('2026-10-05T20:30:00.000Z'));
    await service.listToday('org-1', null);
    expect(where().sessionDate).toEqual({
      gte: new Date('2026-10-05T18:30:00.000Z'),
      lt: new Date('2026-10-06T18:30:00.000Z'),
    });
  });

  it('narrows to a branch only when one is given', async () => {
    jest.setSystemTime(new Date('2026-10-06T06:00:00.000Z'));
    await service.listToday('org-1', null, 'branch-1');
    expect(where()).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
    });

    findMany.mockClear();
    await service.listToday('org-1', 'trainer-1');
    expect(where()).not.toHaveProperty('branchId');
    expect(where()).toMatchObject({
      member: { assignedTrainerId: 'trainer-1' },
    });
  });
});
