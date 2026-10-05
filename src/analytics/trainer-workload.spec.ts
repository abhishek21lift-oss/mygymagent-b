import 'reflect-metadata';
import { TrainerIntelligenceService } from './trainer-intelligence.service';

describe('TrainerIntelligenceService.getWorkload', () => {
  it('adds delivery stats keyed by StaffProfile id', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'user-1',
            firstName: 'T',
            lastName: 'R',
            staffProfile: { id: 'profile-1' },
          },
          {
            id: 'user-2',
            firstName: 'N',
            lastName: 'P',
            staffProfile: null,
          },
        ]),
      },
      member: { count: jest.fn().mockResolvedValue(5) },
      workoutAssignment: { count: jest.fn().mockResolvedValue(2) },
      dietAssignment: { count: jest.fn().mockResolvedValue(1) },
      ptSession: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'COMPLETED', _count: 8 },
          { status: 'NO_SHOW', _count: 2 },
        ]),
      },
    };
    const service = new TrainerIntelligenceService(prisma as never);
    const result = await service.getWorkload('org-1', null);
    expect(result.trainers[0]).toMatchObject({
      sessionsCompleted30d: 8,
      sessionsNoShow30d: 2,
      sessionCompletionPct: 80,
    });
    // Profile id (not user id) scopes the session read.
    expect(prisma.ptSession.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ trainerId: 'profile-1' }),
      }),
    );
    // No profile still returns a row with null completion, not a crash.
    expect(result.trainers[1].sessionCompletionPct).toBe(80);
  });
});
