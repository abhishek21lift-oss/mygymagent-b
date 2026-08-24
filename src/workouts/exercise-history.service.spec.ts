import { NotFoundException } from '@nestjs/common';
import { ExerciseHistoryService } from './exercise-history.service';

describe('ExerciseHistoryService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  } as any;
  const service = new ExerciseHistoryService(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('rejects a member outside the caller tenant', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.getMemberExerciseHistory('org-a', 'member-b', 'exercise-a'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects an exercise outside the caller tenant', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'member-a' }])
      .mockResolvedValueOnce([]);

    await expect(
      service.getMemberExerciseHistory('org-a', 'member-a', 'exercise-b'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('returns only history after both tenant-owned resources are verified', async () => {
    const rows = [{ session_id: 'session-a', set_number: 1, weight_kg: 80, reps: 8 }];
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'member-a' }])
      .mockResolvedValueOnce([{ id: 'exercise-a', name: 'Bench Press' }])
      .mockResolvedValueOnce(rows);

    await expect(
      service.getMemberExerciseHistory('org-a', 'member-a', 'exercise-a', 20),
    ).resolves.toEqual(rows);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
