import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ExerciseHistoryRow {
  session_id: string;
  session_date: Date;
  session_status: string;
  set_number: number;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
}

/**
 * One row per logged set of one library exercise, newest session first.
 *
 * Set rows reference the per-session snapshot entry id
 * (`WorkoutSessionSet.exerciseId` = the snapshot entry's `id`, not the
 * library exercise id -- see WorkoutSession.exercises), so the join has
 * to unspool the JSON snapshot to translate library exerciseId ->
 * snapshot entry id. Column names are the Prisma-mapped camelCase ones
 * (see migrations); there is no `rir` column and no separate
 * `workout_session_exercises` table -- earlier versions of this query
 * targeted a schema that never shipped.
 */
@Injectable()
export class ExerciseHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getMemberExerciseHistory(
    organizationId: string,
    memberId: string,
    exerciseId: string,
    limit = 50,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    const exercise = await this.prisma.exercise.findFirst({
      where: { id: exerciseId, organizationId },
      select: { id: true, name: true },
    });
    if (!exercise) throw new NotFoundException('Exercise not found');

    return this.prisma.$queryRaw<ExerciseHistoryRow[]>`
      SELECT
        ws."id" AS session_id,
        ws."sessionDate" AS session_date,
        ws."status" AS session_status,
        wset."setNumber" AS set_number,
        wset."weightKg" AS weight_kg,
        wset."reps" AS reps,
        wset."rpe" AS rpe
      FROM "workout_sessions" ws
      JOIN "workout_session_sets" wset
        ON wset."sessionId" = ws."id"
       AND wset."exerciseId" IN (
         SELECT (entry->>'id')::text
         FROM jsonb_array_elements(ws."exercises") AS entry
         WHERE entry->>'exerciseId' = ${exerciseId}
       )
      WHERE ws."organizationId" = ${organizationId}
        AND ws."memberId" = ${memberId}
      ORDER BY ws."sessionDate" DESC, wset."setNumber" ASC
      LIMIT ${limit}
    `;
  }
}
