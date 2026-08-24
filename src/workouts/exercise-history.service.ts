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
  rir: number | null;
  completed: boolean;
}

@Injectable()
export class ExerciseHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getMemberExerciseHistory(
    organizationId: string,
    memberId: string,
    exerciseId: string,
    limit = 50,
  ) {
    const member = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM members
      WHERE id = ${memberId} AND organization_id = ${organizationId}::uuid
      LIMIT 1
    `;
    if (!member[0]) throw new NotFoundException('Member not found');

    const exercise = await this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM exercises
      WHERE id = ${exerciseId} AND organization_id = ${organizationId}::uuid
      LIMIT 1
    `;
    if (!exercise[0]) throw new NotFoundException('Exercise not found');

    return this.prisma.$queryRaw<ExerciseHistoryRow[]>`
      SELECT
        ws.id AS session_id,
        ws.session_date,
        ws.status AS session_status,
        wset.set_number,
        wset.weight_kg,
        wset.reps,
        wset.rpe,
        wset.rir,
        wset.completed
      FROM workout_sessions ws
      JOIN workout_session_exercises wse ON wse.session_id = ws.id
      JOIN workout_sets wset ON wset.session_exercise_id = wse.id
      WHERE ws.organization_id = ${organizationId}::uuid
        AND ws.client_id = ${memberId}
        AND wse.exercise_id = ${exerciseId}
      ORDER BY ws.session_date DESC, wset.set_number ASC
      LIMIT ${limit}
    `;
  }
}
