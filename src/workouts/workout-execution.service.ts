import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateWorkoutSessionDto } from './dto/create-workout-session.dto';
import type { LogWorkoutSetDto } from './dto/log-workout-set.dto';

type PlanExercise = {
  exerciseId?: string;
  name?: string;
  sets?: number;
  reps?: string | number;
  restSeconds?: number;
  order?: number;
  notes?: string;
};

@Injectable()
export class WorkoutExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async createSession(
    organizationId: string,
    userBranchId: string | null,
    assignmentId: string,
    dto: CreateWorkoutSessionDto,
  ) {
    const assignments = await this.prisma.$queryRaw<Array<{
      id: string;
      member_id: string;
      member_branch_id: string;
      plan_exercises: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT wa.id, wa.member_id, m."primaryBranchId" AS member_branch_id,
             wp.exercises AS plan_exercises
      FROM workout_assignments wa
      JOIN members m ON m.id = wa.member_id
      JOIN workout_plans wp ON wp.id = wa.workout_plan_id
      WHERE wa.id = ${assignmentId}
        AND wa.organization_id = ${organizationId}
        AND wa.status = 'ACTIVE'
        AND m."organizationId" = ${organizationId}
        AND m."deletedAt" IS NULL
        AND wp."organizationId" = ${organizationId}
      LIMIT 1
    `);

    const assignment = assignments[0];
    if (!assignment) throw new NotFoundException('Active workout assignment not found');
    if (userBranchId && assignment.member_branch_id !== userBranchId) {
      throw new NotFoundException('Workout assignment not found');
    }

    const rawExercises = Array.isArray(assignment.plan_exercises)
      ? assignment.plan_exercises as PlanExercise[]
      : [];
    if (rawExercises.length === 0) {
      throw new BadRequestException('Workout plan has no exercises');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO workout_sessions
            (organization_id, assignment_id, member_id, branch_id, session_date, status, notes)
          VALUES
            (${organizationId}, ${assignment.id}, ${assignment.member_id}, ${assignment.member_branch_id}, CURRENT_DATE, 'IN_PROGRESS', ${dto.notes ?? null})
          RETURNING id
        `);
        const session = sessions[0];

        for (const [index, exercise] of rawExercises.entries()) {
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO workout_session_exercises
              (organization_id, session_id, exercise_id, exercise_name, sets_target, reps_target, rest_seconds, display_order, notes)
            VALUES
              (${organizationId}, ${session.id}, ${exercise.exerciseId ?? null}, ${exercise.name ?? 'Exercise'}, ${exercise.sets ?? null}, ${exercise.reps == null ? null : String(exercise.reps)}, ${exercise.restSeconds ?? null}, ${exercise.order ?? index}, ${exercise.notes ?? null})
          `);
        }

        return this.getSession(organizationId, session.id, userBranchId, tx);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('workout_sessions_assignment_day_unique')) {
        throw new ConflictException('A workout session already exists for this assignment today');
      }
      throw error;
    }
  }

  async listToday(organizationId: string, userBranchId: string | null) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT ws.id, ws.assignment_id AS "assignmentId", ws.member_id AS "memberId",
             ws.branch_id AS "branchId", ws.session_date AS "sessionDate",
             ws.status, ws.started_at AS "startedAt", ws.completed_at AS "completedAt",
             ws.notes, m."firstName" AS "firstName", m."lastName" AS "lastName",
             wp.name AS "workoutPlanName"
      FROM workout_sessions ws
      JOIN members m ON m.id = ws.member_id AND m."organizationId" = ${organizationId}
      JOIN workout_assignments wa ON wa.id = ws.assignment_id AND wa.organization_id = ${organizationId}
      JOIN workout_plans wp ON wp.id = wa.workout_plan_id AND wp."organizationId" = ${organizationId}
      WHERE ws.organization_id = ${organizationId}
        AND ws.session_date = CURRENT_DATE
        ${userBranchId ? Prisma.sql`AND ws.branch_id = ${userBranchId}` : Prisma.empty}
      ORDER BY ws.started_at DESC
    `);
  }

  async getSession(
    organizationId: string,
    sessionId: string,
    userBranchId: string | null,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const sessions = await client.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT ws.id, ws.assignment_id AS "assignmentId", ws.member_id AS "memberId",
             ws.branch_id AS "branchId", ws.session_date AS "sessionDate", ws.status,
             ws.started_at AS "startedAt", ws.completed_at AS "completedAt", ws.notes,
             m."firstName" AS "firstName", m."lastName" AS "lastName", wp.name AS "workoutPlanName"
      FROM workout_sessions ws
      JOIN members m ON m.id = ws.member_id AND m."organizationId" = ${organizationId}
      JOIN workout_assignments wa ON wa.id = ws.assignment_id AND wa.organization_id = ${organizationId}
      JOIN workout_plans wp ON wp.id = wa.workout_plan_id AND wp."organizationId" = ${organizationId}
      WHERE ws.id = ${sessionId}
        AND ws.organization_id = ${organizationId}
        ${userBranchId ? Prisma.sql`AND ws.branch_id = ${userBranchId}` : Prisma.empty}
      LIMIT 1
    `);
    const session = sessions[0];
    if (!session) throw new NotFoundException('Workout session not found');

    const exercises = await client.$queryRaw(Prisma.sql`
      SELECT id, exercise_id AS "exerciseId", exercise_name AS "exerciseName",
             sets_target AS "setsTarget", reps_target AS "repsTarget", rest_seconds AS "restSeconds",
             display_order AS "displayOrder", notes
      FROM workout_session_exercises
      WHERE session_id = ${sessionId} AND organization_id = ${organizationId}
      ORDER BY display_order ASC
    `);

    const sets = await client.$queryRaw(Prisma.sql`
      SELECT id, session_exercise_id AS "sessionExerciseId", set_number AS "setNumber",
             weight_kg AS "weightKg", reps, rpe, notes, completed_at AS "completedAt"
      FROM workout_set_logs
      WHERE session_id = ${sessionId} AND organization_id = ${organizationId}
      ORDER BY session_exercise_id, set_number
    `);

    return { ...session, exercises, sets };
  }

  async logSet(
    organizationId: string,
    sessionId: string,
    sessionExerciseId: string,
    userBranchId: string | null,
    dto: LogWorkoutSetDto,
  ) {
    await this.assertSessionExercise(organizationId, sessionId, sessionExerciseId, userBranchId);

    try {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO workout_set_logs
          (organization_id, session_id, session_exercise_id, set_number, weight_kg, reps, rpe, notes)
        VALUES
          (${organizationId}, ${sessionId}, ${sessionExerciseId}, ${dto.setNumber}, ${dto.weightKg ?? null}, ${dto.reps ?? null}, ${dto.rpe ?? null}, ${dto.notes ?? null})
      `);
    } catch (error) {
      if (error instanceof Error && error.message.includes('workout_set_logs_set_unique')) {
        throw new ConflictException('That set number is already logged for this exercise');
      }
      throw error;
    }

    return this.getSession(organizationId, sessionId, userBranchId);
  }

  async completeSession(organizationId: string, sessionId: string, userBranchId: string | null) {
    await this.assertSession(organizationId, sessionId, userBranchId);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE workout_sessions
      SET status = 'COMPLETED', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE id = ${sessionId} AND organization_id = ${organizationId} AND status = 'IN_PROGRESS'
        ${userBranchId ? Prisma.sql`AND branch_id = ${userBranchId}` : Prisma.empty}
    `);
    return this.getSession(organizationId, sessionId, userBranchId);
  }

  private async assertSession(
    organizationId: string,
    sessionId: string,
    userBranchId: string | null,
  ) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM workout_sessions
      WHERE id = ${sessionId} AND organization_id = ${organizationId}
      ${userBranchId ? Prisma.sql`AND branch_id = ${userBranchId}` : Prisma.empty}
      LIMIT 1
    `);
    if (!rows[0]) throw new NotFoundException('Workout session not found');
  }

  private async assertSessionExercise(
    organizationId: string,
    sessionId: string,
    sessionExerciseId: string,
    userBranchId: string | null,
  ) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT wse.id
      FROM workout_session_exercises wse
      JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE wse.id = ${sessionExerciseId}
        AND wse.session_id = ${sessionId}
        AND wse.organization_id = ${organizationId}
        AND ws.organization_id = ${organizationId}
        ${userBranchId ? Prisma.sql`AND ws.branch_id = ${userBranchId}` : Prisma.empty}
      LIMIT 1
    `);
    if (!rows[0]) throw new NotFoundException('Workout session exercise not found');

    const sessions = await this.prisma.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT status FROM workout_sessions WHERE id = ${sessionId} AND organization_id = ${organizationId}
    `);
    if (sessions[0]?.status !== 'IN_PROGRESS') {
      throw new ConflictException('Workout session is no longer editable');
    }
  }
}
