import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { LogWorkoutSetDto } from './dto/log-workout-set.dto';

interface SqlSession {
  id: string; client_id: string; trainer_id: string | null;
  workout_assignment_id: string | null; session_date: Date; status: string;
}

@Injectable()
export class WorkoutExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async todaySessions(organizationId: string) {
    // PostgreSQL ISODOW: Monday=1 ... Sunday=7, matching workout_exercises.day_of_week.
    return this.prisma.$queryRaw`
      SELECT wa.id AS assignment_id, wa.client_id, wa.trainer_id,
        wp.id AS workout_plan_id, wp.name AS workout_plan_name,
        ws.id AS session_id, COALESCE(ws.status, 'not_started') AS session_status,
        COALESCE(json_agg(json_build_object(
          'id', we.id, 'exerciseId', we.exercise_id, 'sortOrder', we.sort_order,
          'sets', we.sets, 'reps', we.reps, 'restSeconds', we.rest_seconds,
          'targetWeight', we.target_weight, 'rpe', we.rpe, 'notes', we.notes
        ) ORDER BY we.sort_order) FILTER (WHERE we.id IS NOT NULL), '[]'::json) AS exercises
      FROM workout_assignments wa
      JOIN workout_plans wp ON wp.id = wa.workout_plan_id
      LEFT JOIN workout_exercises we ON we.workout_plan_id = wp.id
        AND we.day_of_week = EXTRACT(ISODOW FROM CURRENT_DATE)::int
      LEFT JOIN workout_sessions ws ON ws.workout_assignment_id = wa.id
        AND ws.session_date = CURRENT_DATE
      WHERE wa.organization_id = ${organizationId}::uuid AND wa.status = 'active'
        AND wa.start_date <= CURRENT_DATE AND (wa.end_date IS NULL OR wa.end_date >= CURRENT_DATE)
      GROUP BY wa.id, wa.client_id, wa.trainer_id, wp.id, wp.name, ws.id, ws.status
      ORDER BY ws.id NULLS LAST, wa.client_id
    `;
  }

  async start(organizationId: string, assignmentId: string, userId: string) {
    // Use a transaction-scoped advisory lock because the live database currently
    // contains historical duplicate assignment/date rows and therefore cannot
    // safely accept a new unique index without a data-cleanup migration.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${organizationId}:${assignmentId}:session`}))`;

      const existing = await tx.$queryRaw<SqlSession[]>`
        SELECT id, client_id, trainer_id, workout_assignment_id, session_date, status
        FROM workout_sessions WHERE organization_id = ${organizationId}::uuid
          AND workout_assignment_id = ${assignmentId} AND session_date = CURRENT_DATE
        ORDER BY created_at DESC LIMIT 1`;
      if (existing[0]) return existing[0];

      const assignment = await tx.$queryRaw<Array<{ id: string; client_id: string; trainer_id: string | null }>>`
        SELECT id, client_id, trainer_id FROM workout_assignments
        WHERE id = ${assignmentId} AND organization_id = ${organizationId}::uuid
          AND status = 'active' AND start_date <= CURRENT_DATE
          AND (end_date IS NULL OR end_date >= CURRENT_DATE) LIMIT 1`;
      if (!assignment[0]) throw new NotFoundException('Active workout assignment not found');

      const created = await tx.$queryRaw<SqlSession[]>`
        INSERT INTO workout_sessions
          (client_id, trainer_id, workout_assignment_id, session_date, status, created_by, organization_id)
        VALUES
          (${assignment[0].client_id}, ${assignment[0].trainer_id}, ${assignmentId}, CURRENT_DATE, 'in_progress', ${userId}, ${organizationId}::uuid)
        RETURNING id, client_id, trainer_id, workout_assignment_id, session_date, status`;
      return created[0];
    });
  }

  async logSet(organizationId: string, sessionId: string, sessionExerciseId: string, dto: LogWorkoutSetDto) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM workout_sessions WHERE id = ${sessionId} AND organization_id = ${organizationId}::uuid LIMIT 1`;
      if (!session[0]) throw new NotFoundException('Workout session not found');

      const exercise = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM workout_session_exercises WHERE id = ${sessionExerciseId} AND session_id = ${sessionId} LIMIT 1`;
      if (!exercise[0]) throw new NotFoundException('Session exercise not found');

      if (dto.clientToken) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${sessionExerciseId}:${dto.clientToken}`}))`;
        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM workout_sets WHERE session_exercise_id = ${sessionExerciseId}
            AND client_token = ${dto.clientToken} LIMIT 1`;
        if (existing[0]) return existing[0];
      }

      const rows = await tx.$queryRaw`
        INSERT INTO workout_sets
          (session_exercise_id, set_number, weight_kg, reps, rpe, rir, tempo, rest_seconds, completed, notes, client_token)
        VALUES
          (${sessionExerciseId}, ${dto.setNumber}, ${dto.weightKg ?? null}, ${dto.reps ?? null}, ${dto.rpe ?? null}, ${dto.rir ?? null}, ${dto.tempo ?? null}, ${dto.restSeconds ?? null}, ${dto.completed ?? false}, ${dto.notes ?? null}, ${dto.clientToken ?? null})
        RETURNING id, session_exercise_id, set_number, weight_kg, reps, rpe, rir, completed`;
      return rows[0];
    });
  }

  async complete(organizationId: string, sessionId: string, notes?: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; status: string }>>`
      UPDATE workout_sessions SET status = 'completed', notes = COALESCE(${notes ?? null}, notes), updated_at = now()
      WHERE id = ${sessionId} AND organization_id = ${organizationId}::uuid AND status <> 'completed'
      RETURNING id, status`;
    if (rows[0]) return rows[0];
    const existing = await this.prisma.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM workout_sessions WHERE id = ${sessionId} AND organization_id = ${organizationId}::uuid LIMIT 1`;
    if (!existing[0]) throw new NotFoundException('Workout session not found');
    return existing[0];
  }
}
