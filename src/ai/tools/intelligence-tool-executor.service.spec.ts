import { IntelligenceToolExecutorService } from './intelligence-tool-executor.service';

describe('IntelligenceToolExecutorService', () => {
  const baseExecutor = { execute: jest.fn() } as never;
  const exerciseHistory = {
    getMemberExerciseHistory: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('returns insufficient_data without inventing a progression signal', async () => {
    exerciseHistory.getMemberExerciseHistory.mockResolvedValue([
      {
        session_id: 's1',
        session_date: new Date('2026-08-20'),
        session_status: 'COMPLETED',
        set_number: 1,
        weight_kg: null,
        reps: null,
        rpe: null,
        rir: null,
        completed: false,
      },
    ]);

    const service = new IntelligenceToolExecutorService(
      baseExecutor,
      exerciseHistory as never,
    );

    const result = await service.execute(
      'analyze_workout_progress',
      {
        memberId: '550e8400-e29b-41d4-a716-446655440001',
        exerciseId: '550e8400-e29b-41d4-a716-446655440002',
      },
      {
        organizationId: '550e8400-e29b-41d4-a716-446655440003',
        userId: '550e8400-e29b-41d4-a716-446655440004',
      },
    );

    expect(result).toEqual({
      status: 'insufficient_data',
      dataAvailable: false,
      message: 'No completed sets with recorded weight and reps were found.',
      evidence: [],
    });
  });

  it('computes an evidence-backed progression signal from real sets', async () => {
    exerciseHistory.getMemberExerciseHistory.mockResolvedValue([
      {
        session_id: 's2',
        session_date: new Date('2026-08-20'),
        session_status: 'COMPLETED',
        set_number: 1,
        weight_kg: 100,
        reps: 8,
        rpe: 8,
        rir: 2,
        completed: true,
      },
      {
        session_id: 's1',
        session_date: new Date('2026-08-13'),
        session_status: 'COMPLETED',
        set_number: 1,
        weight_kg: 90,
        reps: 8,
        rpe: 8,
        rir: 2,
        completed: true,
      },
    ]);

    const service = new IntelligenceToolExecutorService(
      baseExecutor,
      exerciseHistory as never,
    );
    const result = await service.execute(
      'analyze_workout_progress',
      {
        memberId: '550e8400-e29b-41d4-a716-446655440001',
        exerciseId: '550e8400-e29b-41d4-a716-446655440002',
      },
      {
        organizationId: '550e8400-e29b-41d4-a716-446655440003',
        userId: '550e8400-e29b-41d4-a716-446655440004',
      },
    );

    expect(result).toMatchObject({
      status: 'ok',
      dataAvailable: true,
      signal: 'progressing',
      sessionsAnalyzed: 2,
      latestAverageVolume: 800,
      previousAverageVolume: 720,
      changePercent: 11.11,
      guardrails: {
        predictionMade: false,
        workoutModified: false,
        recommendationRequired: true,
      },
    });
  });
});
