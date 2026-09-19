import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  RISK_FACTORS,
  RiskFactorInput,
  RiskFactorResult,
  computeFactorScore,
  getRiskLevel,
} from './risk-factors';
import { MemberRiskProfile, RiskLevel, RiskTrend } from '@prisma/client';

export interface MemberRiskProfileOutput {
  memberId: string;
  overallScore: number;
  riskLevel: RiskLevel;
  trend: RiskTrend;
  contributingFactors: RiskFactorResult[];
  protectiveFactors: string[];
  computedAt: Date;
}

export interface MemberIntelligenceSummary {
  memberId: string;
  riskProfile: MemberRiskProfileOutput | null;
  attendanceVelocity: number;
  paymentReliability: number;
  engagementScore: number;
  membershipStatus: string;
  daysUntilExpiry: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class RiskEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async computeRiskProfile(
    organizationId: string,
    memberId: string,
  ): Promise<MemberRiskProfileOutput | null> {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
      },
      include: {
        memberships: {
          where: { status: { in: ['ACTIVE', 'PENDING'] } },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
        attendances: {
          orderBy: { checkInAt: 'desc' },
          take: 60,
        },
        goals: {
          where: { status: 'ACTIVE' },
          include: { milestones: true },
        },
        tagAssignments: {
          where: {
            tag: {
              name: { in: ['complaint', 'churned', 'at-risk', 'unhappy'] },
            },
          },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 12,
        },
      },
    });

    if (!member) return null;

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * MS_PER_DAY);
    const sixtyDaysAgo = new Date(now - 60 * MS_PER_DAY);

    const attendanceLast30Days = member.attendances.filter(
      (a) => a.checkInAt >= thirtyDaysAgo,
    ).length;
    const attendancePrevious30Days = member.attendances.filter(
      (a) => a.checkInAt >= sixtyDaysAgo && a.checkInAt < thirtyDaysAgo,
    ).length;

    const daysSinceLastAttendance =
      member.attendances.length > 0
        ? Math.floor(
            (now - member.attendances[0].checkInAt.getTime()) / MS_PER_DAY,
          )
        : Math.floor((now - member.joinedAt.getTime()) / MS_PER_DAY);

    const latestMembership = member.memberships[0];
    const daysUntilExpiry = latestMembership?.endDate
      ? Math.floor((latestMembership.endDate.getTime() - now) / MS_PER_DAY)
      : null;

    const latestMembershipPrice = latestMembership?.price
      ? Number(latestMembership.price)
      : 0;
    const totalPaymentsReceived = member.payments
      .filter((p) => p.status === 'COMPLETED')
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const outstandingBalance = Math.max(
      0,
      latestMembershipPrice - totalPaymentsReceived,
    );

    const latePaymentCount = member.payments.filter(
      (p) => p.status === 'REFUNDED' || p.status === 'FAILED',
    ).length;

    const workoutSessions = await this.prisma.workoutSession.findMany({
      where: {
        memberId,
        createdAt: { gte: thirtyDaysAgo },
      },
    });
    const daysSinceLastWorkout =
      workoutSessions.length > 0
        ? Math.floor(
            (now - workoutSessions[0].createdAt.getTime()) / MS_PER_DAY,
          )
        : daysSinceLastAttendance;

    const overdueMilestones = member.goals.reduce((count, goal) => {
      const overdue = goal.milestones.filter(
        (m) =>
          m.targetDate && m.targetDate.getTime() < now && m.achievedAt === null,
      ).length;
      return count + overdue;
    }, 0);

    const daysSinceJoining = Math.floor(
      (now - member.joinedAt.getTime()) / MS_PER_DAY,
    );
    const memberTenureDays = daysSinceJoining;

    const input: RiskFactorInput = {
      memberId,
      attendanceLast30Days,
      attendancePrevious30Days,
      daysSinceLastAttendance,
      outstandingBalance,
      latePaymentCount,
      daysSinceLastWorkout,
      overdueMilestones,
      daysSinceJoining,
      daysUntilExpiry: daysUntilExpiry ?? 999,
      negativeTagCount: member.tagAssignments.length,
      memberTenureDays,
      hasActiveGoals: member.goals.length > 0,
    };

    const factorResults = this.computeAllFactors(input);
    const overallScore = Math.min(
      100,
      Math.max(
        0,
        factorResults.reduce((sum, f) => sum + f.contribution, 0),
      ),
    );
    const riskLevel = getRiskLevel(overallScore);

    const contributingFactors = factorResults
      .filter((f) => f.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution);
    const protectiveFactors = factorResults
      .filter((f) => f.contribution < 0)
      .map((f) => f.explanation);

    const previousProfile = await this.prisma.memberRiskProfile.findUnique({
      where: { memberId },
    });
    const trend = this.computeTrend(previousProfile, overallScore);

    const computedAt = new Date();

    await this.prisma.memberRiskProfile.upsert({
      where: { memberId },
      update: {
        overallScore,
        riskLevel,
        trend,
        contributingFactors: contributingFactors as any,
        protectiveFactors,
        computedAt,
        updatedAt: computedAt,
      },
      create: {
        organizationId,
        memberId,
        overallScore,
        riskLevel,
        trend,
        contributingFactors: contributingFactors as any,
        protectiveFactors,
        computedAt,
        updatedAt: computedAt,
      },
    });

    return {
      memberId,
      overallScore,
      riskLevel,
      trend,
      contributingFactors,
      protectiveFactors,
      computedAt,
    };
  }

  private computeAllFactors(input: RiskFactorInput): RiskFactorResult[] {
    const attendanceDeclineRate =
      input.attendancePrevious30Days > 0
        ? (input.attendancePrevious30Days - input.attendanceLast30Days) /
          input.attendancePrevious30Days
        : input.attendanceLast30Days > 0
          ? 1
          : 0;

    const results: RiskFactorResult[] = [];

    const attendanceResult = computeFactorScore(
      RISK_FACTORS.ATTENDANCE_DECLINE,
      attendanceDeclineRate,
      false,
    );
    results.push({
      factor: 'ATTENDANCE_DECLINE',
      weight: RISK_FACTORS.ATTENDANCE_DECLINE.weight,
      rawValue: attendanceDeclineRate,
      normalizedValue:
        attendanceResult.score / RISK_FACTORS.ATTENDANCE_DECLINE.weight,
      contribution: attendanceResult.score,
      threshold: attendanceResult.threshold,
      direction: 'NEGATIVE',
      explanation: attendanceResult.explanation,
    });

    const paymentScore =
      input.outstandingBalance > 0
        ? Math.min(3, Math.floor(input.outstandingBalance / 500))
        : 0 + input.latePaymentCount;
    const paymentResult = computeFactorScore(
      RISK_FACTORS.PAYMENT_RELIABILITY,
      paymentScore,
      false,
    );
    results.push({
      factor: 'PAYMENT_RELIABILITY',
      weight: RISK_FACTORS.PAYMENT_RELIABILITY.weight,
      rawValue: paymentScore,
      normalizedValue:
        paymentResult.score / RISK_FACTORS.PAYMENT_RELIABILITY.weight,
      contribution: paymentResult.score,
      threshold: paymentResult.threshold,
      direction: 'NEGATIVE',
      explanation: paymentResult.explanation,
    });

    const engagementResult = computeFactorScore(
      RISK_FACTORS.ENGAGEMENT_DROP,
      input.daysSinceLastWorkout,
      false,
    );
    results.push({
      factor: 'ENGAGEMENT_DROP',
      weight: RISK_FACTORS.ENGAGEMENT_DROP.weight,
      rawValue: input.daysSinceLastWorkout,
      normalizedValue:
        engagementResult.score / RISK_FACTORS.ENGAGEMENT_DROP.weight,
      contribution: engagementResult.score,
      threshold: engagementResult.threshold,
      direction: 'NEGATIVE',
      explanation: engagementResult.explanation,
    });

    const goalResult = computeFactorScore(
      RISK_FACTORS.GOAL_STAGNATION,
      input.overdueMilestones,
      false,
    );
    results.push({
      factor: 'GOAL_STAGNATION',
      weight: RISK_FACTORS.GOAL_STAGNATION.weight,
      rawValue: input.overdueMilestones,
      normalizedValue: goalResult.score / RISK_FACTORS.GOAL_STAGNATION.weight,
      contribution: goalResult.score,
      threshold: goalResult.threshold,
      direction: 'NEGATIVE',
      explanation: goalResult.explanation,
    });

    const newMemberResult = computeFactorScore(
      RISK_FACTORS.NEW_MEMBER_RISK,
      input.daysSinceJoining,
      false,
    );
    results.push({
      factor: 'NEW_MEMBER_RISK',
      weight: RISK_FACTORS.NEW_MEMBER_RISK.weight,
      rawValue: input.daysSinceJoining,
      normalizedValue:
        newMemberResult.score / RISK_FACTORS.NEW_MEMBER_RISK.weight,
      contribution: newMemberResult.score,
      threshold: newMemberResult.threshold,
      direction: 'NEGATIVE',
      explanation: newMemberResult.explanation,
    });

    if (input.daysUntilExpiry !== null && input.daysUntilExpiry <= 30) {
      const renewalResult = computeFactorScore(
        RISK_FACTORS.RENEWAL_PROXIMITY,
        input.daysUntilExpiry,
        false,
      );
      results.push({
        factor: 'RENEWAL_PROXIMITY',
        weight: RISK_FACTORS.RENEWAL_PROXIMITY.weight,
        rawValue: input.daysUntilExpiry,
        normalizedValue:
          renewalResult.score / RISK_FACTORS.RENEWAL_PROXIMITY.weight,
        contribution: renewalResult.score,
        threshold: renewalResult.threshold,
        direction: 'NEGATIVE',
        explanation: renewalResult.explanation,
      });
    }

    if (input.negativeTagCount > 0) {
      const tagResult = computeFactorScore(
        RISK_FACTORS.TAG_RISK_SIGNALS,
        input.negativeTagCount,
        false,
      );
      results.push({
        factor: 'TAG_RISK_SIGNALS',
        weight: RISK_FACTORS.TAG_RISK_SIGNALS.weight,
        rawValue: input.negativeTagCount,
        normalizedValue: tagResult.score / RISK_FACTORS.TAG_RISK_SIGNALS.weight,
        contribution: tagResult.score,
        threshold: tagResult.threshold,
        direction: 'NEGATIVE',
        explanation: tagResult.explanation,
      });
    }

    if (input.memberTenureDays >= 90) {
      const tenureResult = computeFactorScore(
        RISK_FACTORS.MEMBER_TENURE,
        input.memberTenureDays,
        true,
      );
      results.push({
        factor: 'MEMBER_TENURE',
        weight: Math.abs(RISK_FACTORS.MEMBER_TENURE.weight),
        rawValue: input.memberTenureDays,
        normalizedValue:
          tenureResult.score / Math.abs(RISK_FACTORS.MEMBER_TENURE.weight),
        contribution: -tenureResult.score,
        threshold: tenureResult.threshold,
        direction: 'POSITIVE',
        explanation: `Long-term member (${input.memberTenureDays} days) is ${100 - tenureResult.score}% less likely to churn`,
      });
    }

    return results;
  }

  private computeTrend(
    previous: MemberRiskProfile | null,
    currentScore: number,
  ): RiskTrend {
    if (!previous) return 'STABLE';
    const diff = currentScore - previous.overallScore;
    if (diff <= -5) return 'IMPROVING';
    if (diff >= 5) return 'WORSENING';
    return 'STABLE';
  }

  async getMemberIntelligence(
    organizationId: string,
    memberId: string,
  ): Promise<MemberIntelligenceSummary | null> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId, deletedAt: null },
      include: {
        riskProfile: true,
        memberships: {
          where: { status: { in: ['ACTIVE', 'PENDING'] } },
          take: 1,
          orderBy: { startDate: 'desc' },
        },
        attendances: {
          orderBy: { checkInAt: 'desc' },
          take: 30,
        },
      },
    });

    if (!member) return null;

    const thirtyDaysAgo = Date.now() - 30 * MS_PER_DAY;
    const recentAttendance = member.attendances.filter(
      (a) => a.checkInAt.getTime() >= thirtyDaysAgo,
    ).length;

    const attendanceVelocity = recentAttendance / 30;

    const latestMembership = member.memberships[0];
    const membershipStatus = latestMembership?.status ?? 'NONE';

    const daysUntilExpiry = latestMembership?.endDate
      ? Math.floor(
          (latestMembership.endDate.getTime() - Date.now()) / MS_PER_DAY,
        )
      : null;

    const totalPayments = await this.prisma.payment.count({
      where: { memberId, status: 'COMPLETED' },
    });
    const failedPayments = await this.prisma.payment.count({
      where: { memberId, status: { in: ['FAILED', 'REFUNDED'] } },
    });
    const paymentReliability =
      totalPayments > 0 ? (totalPayments - failedPayments) / totalPayments : 1;

    const engagementScore = Math.min(1, attendanceVelocity * 3) * 0.7;

    return {
      memberId,
      riskProfile: member.riskProfile as MemberRiskProfileOutput | null,
      attendanceVelocity,
      paymentReliability,
      engagementScore,
      membershipStatus,
      daysUntilExpiry,
    };
  }

  async batchComputeRiskProfiles(
    organizationId: string,
    branchScope?: string,
  ): Promise<{ processed: number; errors: number }> {
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: 'ACTIVE',
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: { id: true },
    });

    let processed = 0;
    let errors = 0;

    for (const member of members) {
      try {
        await this.computeRiskProfile(organizationId, member.id);
        processed++;
      } catch {
        errors++;
      }
    }

    return { processed, errors };
  }
}
