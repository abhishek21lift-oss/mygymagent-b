import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { LogWorkoutSetDto } from './dto/log-workout-set.dto';

interface SqlSession {
  id: string;
  client_id: string;
  trainer_id: string | null;
  workout_assignment_id: string | null;
  session_date: Date;
  status: string;
}

@Injectable()
export class WorkoutExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async start(organizationId: string, assignmentId: string, userId: string) {
    const rows = await this.prisma.$queryRaw<SqlSession[]>`
      SELECT id, client_id, trainer_id, workout_assignment_id, session_date, status
      FROM workout_sessions
      WHERE organization_id = ${organizationId}::uuid
        AND workout_assignment_id = ${assignmentId}
        AND session_date = CURRENT_DATE
      LIMIT 1
    `;

    if (rows[0]) return rows[0];

    const assignment = await this.prisma.$queryRaw<Array<{ id: string; client_id: string; trainer_id: string | null }>>`
      SELECT id, client_id, trainer_id
      FROM workout_assignments
      WHERE id = ${assignmentId}
        AND organization_id = ${organizationId}::uuid
        AND status = 'active'
        AND start_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      LIMIT 1
    `;
    if (!assignment[0]) throw new NotFoundException('Active workout assignment not found');

    const created = await this.prisma.$queryRaw<SqlSession[]>`
      INSERT INTO workout_sessions
        (client_id, trainer_id, workout_assignment_id, session_date, status, created_by, organization_id)
      VALUES
        (${assignment[0].client_id}, ${assignment[0].trainer_id}, ${assignmentId}, CURRENT_DATE, 'in_progress', ${userId}, ${organizationId}::uuid)
      ON CONFLICT (workout_assignment_id, session_date)
      DO UPDATE SET status = CASE WHEN workout_sessions.status = 'completed' THEN workout_sessions.status ELSE 'in_progress' END,
                    updated_at = now()
      RETURNING id, client_id, trainer_id, workout_assignment_id, session_date, status
    `;

    return created[0];
  }

  async logSet(organizationId: string, sessionId: string, sessionExerciseId: string, dto: LogWorkoutSetDto) {
    const session = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM workout_sessions
      WHERE id = ${sessionId}
        AND organization_id = ${organizationId}::uuid
      LIMIT 1
    `;
    if (!session[0]) throw new NotFoundException('Workout session not found');

    const exercise = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM workout_session_exercises
      WHERE id = ${sessionExerciseId} AND session_id = ${sessionId}
      LIMIT 1
    `;
    if (!exercise[0]) throw new NotFoundException('Session exercise not found');

    const existing = dto.clientToken
      ? await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM workout_sets
          WHERE session_exercise_id = ${sessionExerciseId} AND client_token = ${dto.clientToken}
          LIMIT 1
        `
      : [];
    if (existing[0]) return existing[0];

    const rows = await this.prisma.$queryRaw`
      INSERT INTO workout_sets
        (session_exercise_id, set_number, weight_kg, reps, rpe, rir, tempo, rest_seconds, completed, notes, client_token)
      VALUES
        (${sessionExerciseId}, ${dto.setNumber}, ${dto.weightKg ?? null}, ${dto.reps ?? null}, ${dto.rpe ?? null}, ${dto.rir ?? null}, ${dto.tempo ?? null}, ${dto.restSeconds ?? null}, ${dto.completed ?? false}, ${dto.notes ?? null}, ${dto.clientToken ?? null})
      ON CONFLICT DO NOTHING
      RETURNING id, session_exercise_id, set_number, weight_kg, reps, rpe, rir, completed
    `;
    return rows[0];
  }

  async complete(organizationId: string, sessionId: string, notes?: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; status: string }>>`
      UPDATE workout_sessions
      SET status = 'completed',
          notes = COALESCE(${notes ?? null}, notes),
          updated_at = now()
      WHERE id = ${sessionId}
        AND organization_id = ${organizationId}::uuid
        AND status <> 'completed'
      RETURNING id, status
    `;
    if (!rows[0]) {
      const existing = await this.prisma.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM workout_sessions
        WHERE id = ${sessionId} AND organization_id = ${organizationId}::uuid
        LIMIT 1
      `;
      if (!existing[0]) throw new NotFoundException('Workout session not found');
      return existing[0];
    }
    return rows[0];
  }
}
