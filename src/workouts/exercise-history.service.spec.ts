import { NotFoundException } from '@nestjs/common';
import { ExerciseHistoryService } from './exercise-history.service';

describe('ExerciseHistoryService', () => {
  const prisma = {
    member: { findFirst: jest.fn() },
    exercise: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
  } as any;
  const service = new ExerciseHistoryService(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('rejects a member outside the caller tenant', async () => {
    prisma.member.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.getMemberExerciseHistory('org-a', 'member-b', 'exercise-a'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.member.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an exercise outside the caller tenant', async () => {
    prisma.member.findFirst.mockResolvedValueOnce({ id: 'member-a' });
    prisma.exercise.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.getMemberExerciseHistory('org-a', 'member-a', 'exercise-b'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.exercise.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns only history after both tenant-owned resources are verified', async () => {
    const rows = [
      { session_id: 'session-a', set_number: 1, weight_kg: 80, reps: 8 },
    ];
    prisma.member.findFirst.mockResolvedValueOnce({ id: 'member-a' });
    prisma.exercise.findFirst.mockResolvedValueOnce({
      id: 'exercise-a',
      name: 'Bench Press',
    });
    prisma.$queryRaw.mockResolvedValueOnce(rows);

    await expect(
      service.getMemberExerciseHistory('org-a', 'member-a', 'exercise-a', 20),
    ).resolves.toEqual(rows);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('scopes the history query by tenant and member', async () => {
    prisma.member.findFirst.mockResolvedValueOnce({ id: 'member-a' });
    prisma.exercise.findFirst.mockResolvedValueOnce({ id: 'exercise-a' });
    // Tagged-template call: $queryRaw(strings, ...values)
    prisma.$queryRaw.mockImplementationOnce((strings, ...values) => {
      const text = strings.join('?');
      return Promise.resolve([{ text, values }]);
    });

    await service.getMemberExerciseHistory(
      'org-a',
      'member-a',
      'exercise-a',
      10,
    );

    const call = prisma.$queryRaw.mock.calls[0];
    const sql: string = call[0].join('${');
    expect(sql).toContain('"organizationId"');
    expect(sql).toContain('"memberId"');
    // Targeted at the real schema: camelCase columns, snapshot join.
    expect(sql).toContain('"workout_session_sets"');
    expect(sql).toContain('jsonb_array_elements');
  });
});
