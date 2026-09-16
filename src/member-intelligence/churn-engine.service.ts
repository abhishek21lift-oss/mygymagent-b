import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ChurnIndicator =
  | 'RISK_ESCALATION'
  | 'CHURN_IMMINENT'
  | 'PAYMENT_FAILED_AT_RISK'
  | 'RENEWAL_WINDOW'
  | 'RE_ENGAGEMENT_WINDOW'
  | 'CHAMPION_AT_RISK';

export type RetentionTrigger =
  'SAVEABLE' | 'DISCOUNT_CANDIDATE' | 'RE_ENGAGEMENT' | 'CHAMPION';

export interface ChurnIndicatorResult {
  memberId: string;
  indicator: ChurnIndicator;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  detectedAt: Date;
}

export interface RetentionOpportunity {
  memberId: string;
  trigger: RetentionTrigger;
  priority: 'P0' | 'P1' | 'P2';
  description: string;
  recommendedActions: string[];
}

export interface MemberChurnAssessment {
  memberId: string;
  isAtRisk: boolean;
  churnProbability: number;
  churnIndicators: ChurnIndicatorResult[];
  retentionOpportunity: RetentionOpportunity | null;
  nextBestAction: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class ChurnEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async assessMemberChurn(
    organizationId: string,
    memberId: string,
  ): Promise<MemberChurnAssessment | null> {
    const [
      member,
      riskProfile,
      latestMembership,
      recentPayments,
      recentAttendances,
      openFollowUps,
    ] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: memberId, organizationId, deletedAt: null },
        select: {
          id: true,
          joinedAt: true,
          assignedTrainerId: true,
          primaryBranchId: true,
          firstName: true,
          lastName: true,
        },
      }),
      this.prisma.memberRiskProfile.findUnique({
        where: { memberId },
        select: { overallScore: true, riskLevel: true, trend: true },
      }),
      this.prisma.membership.findFirst({
        where: { memberId, status: { in: ['ACTIVE', 'PENDING'] } },
        select: { endDate: true, startDate: true, price: true },
        orderBy: { endDate: 'desc' },
      }),
      this.prisma.payment.findMany({
        where: { memberId },
        select: { status: true, amount: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.attendance.findMany({
        where: { memberId },
        select: { checkInAt: true },
        orderBy: { checkInAt: 'desc' },
        take: 30,
      }),
      this.prisma.memberFollowUp.findMany({
        where: { memberId, completedAt: null },
        select: { id: true, dueAt: true, title: true },
        orderBy: { dueAt: 'asc' },
        take: 3,
      }),
    ]);

    if (!member) return null;

    const indicators: ChurnIndicatorResult[] = [];
    const now = Date.now();

    if (riskProfile) {
      if (
        riskProfile.riskLevel === 'CRITICAL' ||
        riskProfile.riskLevel === 'HIGH'
      ) {
        if (recentAttendances.length > 0) {
          const latestAttendance = recentAttendances[0];
          const daysSinceAttendance = Math.floor(
            (now - latestAttendance.checkInAt.getTime()) / MS_PER_DAY,
          );
          if (daysSinceAttendance <= 7) {
            indicators.push({
              memberId,
              indicator: 'RISK_ESCALATION' as ChurnIndicator,
              severity: riskProfile.riskLevel as
                'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
              description: `${riskProfile.riskLevel} risk but attended within 7 days — still engaged`,
              detectedAt: new Date(),
            });
          }
        }

        if (recentPayments.length > 0) {
          const latestPayment = recentPayments[0];
          if (latestPayment.status === 'FAILED') {
            indicators.push({
              memberId,
              indicator: 'PAYMENT_FAILED_AT_RISK',
              severity: 'CRITICAL',
              description: `Payment failed for member with ${riskProfile.riskLevel} risk`,
              detectedAt: new Date(),
            });
          }
        }
      }

      if (latestMembership?.endDate) {
        const daysUntilExpiry = Math.floor(
          (latestMembership.endDate.getTime() - now) / MS_PER_DAY,
        );
        if (daysUntilExpiry <= 7 && daysUntilExpiry >= 0) {
          indicators.push({
            memberId,
            indicator: 'RENEWAL_WINDOW',
            severity: daysUntilExpiry <= 3 ? 'HIGH' : 'MEDIUM',
            description: `Membership expires in ${daysUntilExpiry} days`,
            detectedAt: new Date(),
          });
        }
      }

      const thirtyDaysAgo = new Date(now - 30 * MS_PER_DAY);
      const recentAttendanceInMonth = recentAttendances.filter(
        (a) => a.checkInAt >= thirtyDaysAgo,
      );
      if (
        recentAttendanceInMonth.length === 0 &&
        recentAttendances.length > 0
      ) {
        indicators.push({
          memberId,
          indicator: 'RE_ENGAGEMENT_WINDOW',
          severity: 'MEDIUM',
          description:
            'No attendance in 30 days but has history — re-engagement window',
          detectedAt: new Date(),
        });
      }
    }

    const isAtRisk =
      riskProfile?.riskLevel === 'CRITICAL' ||
      riskProfile?.riskLevel === 'HIGH' ||
      indicators.some(
        (i) =>
          i.indicator === 'PAYMENT_FAILED_AT_RISK' ||
          i.indicator === 'RENEWAL_WINDOW',
      );

    let churnProbability = 0;
    if (riskProfile) {
      if (riskProfile.riskLevel === 'CRITICAL') churnProbability = 0.8;
      else if (riskProfile.riskLevel === 'HIGH') churnProbability = 0.5;
      else if (riskProfile.riskLevel === 'MEDIUM') churnProbability = 0.25;
      else churnProbability = 0.1;
    }

    const hasOpenFollowUps = openFollowUps.length > 0;
    if (hasOpenFollowUps) {
      churnProbability *= 0.9;
    }

    let retentionOpportunity: RetentionOpportunity | null = null;
    let nextBestAction: string | null = null;

    if (isAtRisk && riskProfile) {
      const hasRecentAttendance =
        recentAttendances.length > 0 &&
        Math.floor(
          (now - recentAttendances[0].checkInAt.getTime()) / MS_PER_DAY,
        ) <= 7;
      const hasPaymentFailure =
        recentPayments.length > 0 && recentPayments[0].status === 'FAILED';
      const hasRenewalWindow =
        latestMembership?.endDate &&
        Math.floor((latestMembership.endDate.getTime() - now) / MS_PER_DAY) <=
          7 &&
        Math.floor((latestMembership.endDate.getTime() - now) / MS_PER_DAY) >=
          0;

      if (hasRecentAttendance) {
        retentionOpportunity = {
          memberId,
          trigger: 'SAVEABLE',
          priority: 'P0',
          description:
            'High risk but still engaged — best time for intervention',
          recommendedActions: [
            'Personal outreach from assigned trainer',
            'Offer complimentary assessment session',
            'Send engagement-focused communication',
          ],
        };
        nextBestAction = 'Schedule personal outreach call';
      } else if (hasPaymentFailure) {
        retentionOpportunity = {
          memberId,
          trigger: 'DISCOUNT_CANDIDATE',
          priority: 'P0',
          description:
            'Payment failure at high risk — needs immediate resolution',
          recommendedActions: [
            'Contact to resolve payment issue',
            'Offer payment plan if needed',
            'Consider freeze if life event',
          ],
        };
        nextBestAction = 'Resolve payment issue immediately';
      } else if (hasRenewalWindow) {
        retentionOpportunity = {
          memberId,
          trigger: 'DISCOUNT_CANDIDATE',
          priority: 'P1',
          description: 'Renewal window with risk indicators',
          recommendedActions: [
            'Send renewal reminder with offer',
            'Offer freeze extension if applicable',
            'Highlight value delivered so far',
          ],
        };
        nextBestAction = 'Send renewal offer with incentive';
      } else {
        retentionOpportunity = {
          memberId,
          trigger: 'RE_ENGAGEMENT',
          priority: 'P1',
          description: 'At risk with engagement drop',
          recommendedActions: [
            'Send re-engagement communication',
            'Offer goal reset session',
            'Provide workout variety',
          ],
        };
        nextBestAction = 'Send re-engagement message';
      }
    }

    const memberTenureDays = Math.floor(
      (now - member.joinedAt.getTime()) / MS_PER_DAY,
    );
    const isChampion =
      riskProfile?.riskLevel === 'LOW' && memberTenureDays > 365;
    if (isChampion) {
      retentionOpportunity = {
        memberId,
        trigger: 'CHAMPION',
        priority: 'P2',
        description: 'Long-term, active member — retention opportunity',
        recommendedActions: [
          'Send appreciation message',
          'Offer upgrade opportunity',
          'Request referral',
        ],
      };
      nextBestAction = nextBestAction ?? 'Send appreciation + upgrade invite';
    }

    return {
      memberId,
      isAtRisk,
      churnProbability: Math.round(churnProbability * 100) / 100,
      churnIndicators: indicators,
      retentionOpportunity,
      nextBestAction,
    };
  }

  async getAtRiskMembersWithAssessment(
    organizationId: string,
    _branchScope?: string,
  ): Promise<MemberChurnAssessment[]> {
    const atRiskProfiles = await this.prisma.memberRiskProfile.findMany({
      where: {
        organizationId,
        riskLevel: { in: ['HIGH', 'CRITICAL'] },
      },
      select: { memberId: true },
    });

    const assessments: MemberChurnAssessment[] = [];

    for (const profile of atRiskProfiles) {
      const assessment = await this.assessMemberChurn(
        organizationId,
        profile.memberId,
      );
      if (assessment && assessment.isAtRisk) {
        assessments.push(assessment);
      }
    }

    return assessments.sort((a, b) => b.churnProbability - a.churnProbability);
  }
}
