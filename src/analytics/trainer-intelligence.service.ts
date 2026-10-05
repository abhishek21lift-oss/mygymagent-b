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
  /// PT sessions completed in the window (startTime-based).
  sessionsCompleted30d: number;
  /// NO_SHOW sessions in the window.
  sessionsNoShow30d: number;
  /// Completed / (completed + cancelled + no-show), null under 3 decided.
  sessionCompletionPct: number | null;
}

export interface TrainerIntelligence {
  trainers: TrainerWorkload[];
  notComputable: { key: string; reason: string }[];
}

export interface PtOpportunity {
  packageId: string;
  memberId: string;
  firstName: string;
  lastName: string;
  packageName: string;
  sessionsRemaining: number;
  /// Whole days left, 0 when past endDate.
  daysLeft: number;
  reason: 'EXPIRING_WITH_SESSIONS' | 'NEVER_STARTED';
}

export interface PtOpportunities {
  expiring: PtOpportunity[];
  neverStarted: PtOpportunity[];
  counts: { expiring: number; neverStarted: number; activePackages: number };
}

const NOT_COMPUTABLE = [
  {
    key: 'ptSessionUtilization',
    reason:
      'Package-level utilization (used vs. total sessions) exists per package, but is not yet aggregated per trainer.',
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
      select: {
        id: true,
        firstName: true,
        lastName: true,
        staffProfile: { select: { id: true } },
      },
    });

    const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * MS_PER_DAY);

    const workload = await Promise.all(
      trainers.map(async (trainer) => {
        const profileId = (
          trainer as typeof trainer & {
            staffProfile: { id: string } | null;
          }
        ).staffProfile?.id;
        const [
          assignedMemberCount,
          workoutPlansAssigned,
          dietPlansAssigned,
          sessionOutcomes,
        ] = await Promise.all([
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
          // PtSession.trainerId is the StaffProfile id, not the User id.
          // A trainer without a profile matches nothing by construction
          // (single call shape, so groupBy typing stays uniform).
          this.prisma.ptSession.groupBy({
            by: ['status'],
            where: {
              organizationId,
              trainerId: profileId ?? '__no-profile__',
              startTime: { gte: since },
            },
            _count: true,
          }),
        ]);
        const decided = sessionOutcomes
          .filter((r) => r.status !== 'SCHEDULED')
          .reduce((sum, r) => sum + r._count, 0);
        const completed =
          sessionOutcomes.find((r) => r.status === 'COMPLETED')?._count ?? 0;
        const noShow =
          sessionOutcomes.find((r) => r.status === 'NO_SHOW')?._count ?? 0;
        return {
          userId: trainer.id,
          firstName: trainer.firstName,
          lastName: trainer.lastName,
          assignedMemberCount,
          workoutPlansAssignedLast30Days: workoutPlansAssigned,
          dietPlansAssignedLast30Days: dietPlansAssigned,
          sessionsCompleted30d: completed,
          sessionsNoShow30d: noShow,
          sessionCompletionPct:
            decided >= 3 ? Math.round((completed / decided) * 100) : null,
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

  /**
   * PT renewal opportunities from package rows, not guesses. Expiring =
   * ACTIVE packages ending within 14 days with sessions still unused;
   * never-started = ACTIVE packages untouched 14 days after start. Both
   * are capped; counts cover the full scope.
   */
  async getPtOpportunities(
    organizationId: string,
    branchScope: string | null,
  ): Promise<PtOpportunities> {
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * MS_PER_DAY);
    const staleSince = new Date(now.getTime() - 14 * MS_PER_DAY);
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [expiring, neverStarted, activePackages] = await Promise.all([
      this.prisma.ptPackage.findMany({
        where: { ...scoped, status: 'ACTIVE', endDate: { lte: horizon } },
        orderBy: { endDate: 'asc' },
        take: 50,
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.ptPackage.findMany({
        where: {
          ...scoped,
          status: 'ACTIVE',
          usedSessions: 0,
          startDate: { lte: staleSince },
        },
        orderBy: { startDate: 'asc' },
        take: 50,
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.ptPackage.count({
        where: { ...scoped, status: 'ACTIVE' },
      }),
    ]);
    const [expiringCount, neverStartedCount] = await Promise.all([
      this.prisma.ptPackage.count({
        where: { ...scoped, status: 'ACTIVE', endDate: { lte: horizon } },
      }),
      this.prisma.ptPackage.count({
        where: {
          ...scoped,
          status: 'ACTIVE',
          usedSessions: 0,
          startDate: { lte: staleSince },
        },
      }),
    ]);

    const toOpportunity = (
      p: (typeof expiring)[number],
      reason: PtOpportunity['reason'],
    ): PtOpportunity | null => {
      const remaining = p.totalSessions - p.usedSessions;
      if (reason === 'EXPIRING_WITH_SESSIONS' && remaining <= 0) return null;
      return {
        packageId: p.id,
        memberId: p.member.id,
        firstName: p.member.firstName,
        lastName: p.member.lastName,
        packageName: p.name,
        sessionsRemaining: Math.max(0, remaining),
        daysLeft: Math.max(
          0,
          Math.ceil((p.endDate.getTime() - now.getTime()) / MS_PER_DAY),
        ),
        reason,
      };
    };
    const expiringOpportunities = expiring
      .map((p) => toOpportunity(p, 'EXPIRING_WITH_SESSIONS'))
      .filter((o): o is PtOpportunity => o !== null);
    const neverStartedOpportunities = neverStarted
      .map((p) => toOpportunity(p, 'NEVER_STARTED'))
      .filter((o): o is PtOpportunity => o !== null);
    return {
      expiring: expiringOpportunities,
      neverStarted: neverStartedOpportunities,
      counts: {
        expiring: expiringCount,
        neverStarted: neverStartedCount,
        activePackages,
      },
    };
  }
}
