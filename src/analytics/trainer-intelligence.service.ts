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

    const workload = await Promise.all(
      trainers.map(async (trainer) => {
        const [assignedMemberCount, workoutPlansAssigned, dietPlansAssigned] =
          await Promise.all([
            this.prisma.member.count({
              where: {
                organizationId,
                assignedTrainerId: trainer.id,
                status: 'ACTIVE',
              },
            }),
            this.prisma.workoutAssignment.count({
              where: {
                organizationId,
                assignedByUserId: trainer.id,
                createdAt: { gte: since },
              },
            }),
            this.prisma.dietAssignment.count({
              where: {
                organizationId,
                assignedByUserId: trainer.id,
                createdAt: { gte: since },
              },
            }),
          ]);
        return {
          userId: trainer.id,
          firstName: trainer.firstName,
          lastName: trainer.lastName,
          assignedMemberCount,
          workoutPlansAssignedLast30Days: workoutPlansAssigned,
          dietPlansAssignedLast30Days: dietPlansAssigned,
        };
      }),
    );

    return {
      trainers: workload.sort(
        (a, b) => b.assignedMemberCount - a.assignedMemberCount,
      ),
      notComputable: NOT_COMPUTABLE,
    };
  }
}
