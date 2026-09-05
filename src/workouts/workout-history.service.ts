import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkoutHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async memberHistory(
    organizationId: string,
    memberId: string,
    branchId: string | null,
    limit = 30,
  ) {
    const member = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM members
      WHERE id = ${memberId}
        AND "organizationId" = ${organizationId}
        AND "deletedAt" IS NULL
        ${branchId ? Prisma.sql`AND "primaryBranchId" = ${branchId}` : Prisma.empty}
      LIMIT 1
    `);
    if (!member[0]) throw new NotFoundException('Member not found');

    return this.prisma.$queryRaw(Prisma.sql`
      SELECT ws.id,
             ws.session_date AS "sessionDate",
             ws.status,
             ws.started_at AS "startedAt",
             ws.completed_at AS "completedAt",
             wp.name AS "workoutPlanName",
             COALESCE(SUM(wsl.weight_kg * wsl.reps), 0) AS "volumeKg",
             COUNT(wsl.id) AS "setsLogged"
      FROM workout_sessions ws
      JOIN workout_assignments wa ON wa.id = ws.assignment_id
        AND wa.organization_id = ${organizationId}
      JOIN workout_plans wp ON wp.id = wa.workout_plan_id
        AND wp."organizationId" = ${organizationId}
      LEFT JOIN workout_set_logs wsl ON wsl.session_id = ws.id
        AND wsl.organization_id = ${organizationId}
      WHERE ws.organization_id = ${organizationId}
        AND ws.member_id = ${memberId}
        ${branchId ? Prisma.sql`AND ws.branch_id = ${branchId}` : Prisma.empty}
      GROUP BY ws.id, wp.name
      ORDER BY ws.session_date DESC, ws.started_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 100)}
    `);
  }

  async exerciseHistory(
    organizationId: string,
    memberId: string,
    exerciseId: string,
    branchId: string | null,
    limit = 20,
  ) {
    const member = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM members
      WHERE id = ${memberId}
        AND "organizationId" = ${organizationId}
        AND "deletedAt" IS NULL
        ${branchId ? Prisma.sql`AND "primaryBranchId" = ${branchId}` : Prisma.empty}
      LIMIT 1
    `);
    if (!member[0]) throw new NotFoundException('Member not found');

    return this.prisma.$queryRaw(Prisma.sql`
      SELECT ws.session_date AS "sessionDate",
             wse.exercise_name AS "exerciseName",
             wsl.set_number AS "setNumber",
             wsl.weight_kg AS "weightKg",
             wsl.reps,
             wsl.rpe,
             wsl.completed_at AS "completedAt"
      FROM workout_set_logs wsl
      JOIN workout_sessions ws ON ws.id = wsl.session_id
        AND ws.organization_id = ${organizationId}
      JOIN workout_session_exercises wse ON wse.id = wsl.session_exercise_id
        AND wse.organization_id = ${organizationId}
      WHERE ws.member_id = ${memberId}
        AND wse.exercise_id = ${exerciseId}
        ${branchId ? Prisma.sql`AND ws.branch_id = ${branchId}` : Prisma.empty}
      ORDER BY ws.session_date DESC, wsl.set_number ASC
      LIMIT ${Math.min(Math.max(limit, 1), 100)}
    `);
  }
}
