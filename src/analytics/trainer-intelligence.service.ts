import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVITY_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TrainerWorkload {
  userId: string;
  firstName: string;
  lastName: string;
  assignedMemberCount: number;
  workoutPlansAssignedLast30Days: number;
  dietPlansAssignedLast30Days: number;
}

export interface TrainerIntelligence {
  trainers: TrainerWorkload[];
  notComputable: { key: string; reason: string }[];
}

const NOT_COMPUTABLE = [
  {
    key: 'ptSessionUtilization',
    reason:
      "No PT session/package data model exists (see src/automation/README.md's PT-expiry note for the same gap) -- there is no record of scheduled vs. delivered PT sessions to compute utilization from.",
  },
  {
    key: 'ptRevenuePerTrainer',
    reason:
      "A Payment not linked to a membership has no field attributing it to a trainer or PT session -- see src/analytics/README.md's ptRevenue note.",
  },
  {
    key: 'commissionEarned',
    reason:
      'StaffProfile.commissionRate exists, but no Payment records which staff member it should count toward -- the rate has nothing to apply it to.',
  },
];

/**
 * Real, explainable trainer activity -- assigned-member load and recent
 * program-assignment activity, both directly traceable to Member/
 * WorkoutAssignment/DietAssignment rows. Deliberately does not attempt
 * PT-specific metrics (session utilization, PT revenue, commission) --
 * see notComputable, same honesty discipline as FinanceService's.
 */
@Injectable()
export class TrainerIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getWorkload(
    organizationId: string,
    branchScope: string | null,
  ): Promise<TrainerIntelligence> {
    const trainers = await this.prisma.user.findMany({
      where: {
        organizationId,
        deletedAt: null,
        staffProfile: {
          isTrainer: true,
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      },
      select: { id: true, firstName: true, lastName: true },
    });

    const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * MS_PER_DAY);

    if (trainers.length === 0) {
      return { trainers: [], notComputable: NOT_COMPUTABLE };
    }
    const trainerIds = trainers.map((trainer) => trainer.id);
    // Three grouped counts for every trainer at once, not three counts
    // per trainer.
    const [members, workouts, diets] = await Promise.all([
      this.prisma.member.groupBy({
        by: ['assignedTrainerId'],
        where: {
          organizationId,
          assignedTrainerId: { in: trainerIds },
          status: 'ACTIVE',
        },
        _count: true,
      }),
      this.prisma.workoutAssignment.groupBy({
        by: ['assignedByUserId'],
        where: {
          organizationId,
          assignedByUserId: { in: trainerIds },
          createdAt: { gte: since },
        },
        _count: true,
      }),
      this.prisma.dietAssignment.groupBy({
        by: ['assignedByUserId'],
        where: {
          organizationId,
          assignedByUserId: { in: trainerIds },
          createdAt: { gte: since },
        },
        _count: true,
      }),
    ]);
    const memberCount = new Map(
      members.map((row) => [row.assignedTrainerId, row._count]),
    );
    const workoutCount = new Map(
      workouts.map((row) => [row.assignedByUserId, row._count]),
    );
    const dietCount = new Map(
      diets.map((row) => [row.assignedByUserId, row._count]),
    );

    const workload = trainers.map((trainer) => ({
      userId: trainer.id,
      firstName: trainer.firstName,
      lastName: trainer.lastName,
      assignedMemberCount: memberCount.get(trainer.id) ?? 0,
      workoutPlansAssignedLast30Days: workoutCount.get(trainer.id) ?? 0,
      dietPlansAssignedLast30Days: dietCount.get(trainer.id) ?? 0,
    }));

    return {
      trainers: workload.sort(
        (a, b) => b.assignedMemberCount - a.assignedMemberCount,
      ),
      notComputable: NOT_COMPUTABLE,
    };
  }
}
