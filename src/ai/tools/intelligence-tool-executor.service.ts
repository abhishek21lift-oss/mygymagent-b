import { Injectable } from '@nestjs/common';
import { ExerciseHistoryService } from '../../workouts/exercise-history.service';
import { AnalyzeWorkoutProgressArgsDto } from './dto/analyze-workout-progress-args.dto';
import { ToolExecutorService, type ToolCallContext } from './tool-executor.service';
import { validateToolArgs } from './validate-tool-args';
import type { BaseAiToolName } from './intelligence-tool-definitions';

@Injectable()
export class IntelligenceToolExecutorService {
  constructor(
    private readonly baseExecutor: ToolExecutorService,
    private readonly exerciseHistory: ExerciseHistoryService,
  ) {}

  async execute(
    name: string,
    rawArgs: unknown,
    context: ToolCallContext,
  ): Promise<unknown> {
    if (name !== 'analyze_workout_progress') {
      return this.baseExecutor.execute(name as BaseAiToolName, rawArgs, context);
    }

    const { memberId, exerciseId, limit } = validateToolArgs(
      AnalyzeWorkoutProgressArgsDto,
      rawArgs,
    );
    const rows = await this.exerciseHistory.getMemberExerciseHistory(
      context.organizationId,
      memberId,
      exerciseId,
      limit,
    );

    const completed = rows.filter(
      (row) => row.completed && row.weight_kg !== null && row.reps !== null,
    );
    if (completed.length === 0) {
      return {
        status: 'insufficient_data',
        dataAvailable: false,
        message: 'No completed sets with recorded weight and reps were found.',
        evidence: [],
      };
    }

    const ordered = [...completed].sort(
      (a, b) => new Date(a.session_date).getTime() - new Date(b.session_date).getTime(),
    );
    const best = ordered.reduce((current, row) => {
      const currentScore = (current.weight_kg ?? 0) * (current.reps ?? 0);
      const rowScore = (row.weight_kg ?? 0) * (row.reps ?? 0);
      return rowScore > currentScore ? row : current;
    });

    const sessionDates = [...new Set(ordered.map((row) => new Date(row.session_date).toISOString().slice(0, 10)))];
    const latestDate = sessionDates[sessionDates.length - 1];
    const previousDate = sessionDates.length > 1 ? sessionDates[sessionDates.length - 2] : undefined;
    const latestRows = ordered.filter((row) => new Date(row.session_date).toISOString().slice(0, 10) === latestDate);
    const previousRows = previousDate
      ? ordered.filter((row) => new Date(row.session_date).toISOString().slice(0, 10) === previousDate)
      : [];

    const avgVolume = (items: typeof ordered) =>
      items.reduce((sum, row) => sum + (row.weight_kg ?? 0) * (row.reps ?? 0), 0) /
      Math.max(items.length, 1);

    const latestAverageVolume = avgVolume(latestRows);
    const previousAverageVolume = previousRows.length ? avgVolume(previousRows) : null;
    const changePercent = previousAverageVolume
      ? ((latestAverageVolume - previousAverageVolume) / previousAverageVolume) * 100
      : null;

    let signal: 'progressing' | 'regressing' | 'stable' | 'insufficient_data' = 'stable';
    if (changePercent !== null) {
      if (changePercent >= 5) signal = 'progressing';
      else if (changePercent <= -5) signal = 'regressing';
    }
    if (sessionDates.length < 2) signal = 'insufficient_data';

    return {
      status: signal === 'insufficient_data' ? 'insufficient_data' : 'ok',
      dataAvailable: true,
      signal,
      sessionsAnalyzed: sessionDates.length,
      completedSetsAnalyzed: completed.length,
      latestSession: latestDate,
      previousSession: previousDate ?? null,
      latestAverageVolume: Math.round(latestAverageVolume * 100) / 100,
      previousAverageVolume: previousAverageVolume === null ? null : Math.round(previousAverageVolume * 100) / 100,
      changePercent: changePercent === null ? null : Math.round(changePercent * 100) / 100,
      bestRecordedSet: {
        date: new Date(best.session_date).toISOString(),
        weightKg: best.weight_kg,
        reps: best.reps,
        rpe: best.rpe,
        rir: best.rir,
      },
      guardrails: {
        predictionMade: false,
        workoutModified: false,
        recommendationRequired: true,
      },
    };
  }
}
