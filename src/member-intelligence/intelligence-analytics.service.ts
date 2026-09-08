import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RiskLevel } from '@prisma/client';

export interface RiskDistribution {
  riskLevel: RiskLevel;
  count: number;
  percentage: number;
}

export interface RiskOverview {
  totalMembers: number;
  riskDistribution: RiskDistribution[];
  highRiskCount: number;
  criticalRiskCount: number;
  revenueAtRisk: number;
  revenueAtRiskByLevel: {
    HIGH: number;
    CRITICAL: number;
  };
}

export interface RiskTrendPoint {
  date: string;
  avgScore: number;
  highRiskCount: number;
  criticalRiskCount: number;
}

export interface RevenueAtRisk {
  totalMRR: number;
  atRiskMRR: number;
  atRiskPercentage: number;
  bySegment: {
    riskLevel: RiskLevel;
    mrr: number;
    memberCount: number;
  }[];
}

export interface BranchRiskSummary {
  branchId: string;
  branchName: string;
  totalMembers: number;
  riskDistribution: RiskDistribution[];
  avgRiskScore: number;
}

@Injectable()
export class IntelligenceAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getRiskOverview(
    organizationId: string,
    branchScope?: string,
  ): Promise<RiskOverview> {
    const memberWhere = {
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
    };

    const [totalMembers, riskProfiles, memberships] = await Promise.all([
      this.prisma.member.count({ where: memberWhere }),
      this.prisma.memberRiskProfile.findMany({
        where: { organizationId },
        select: { memberId: true, riskLevel: true, overallScore: true },
      }),
      this.prisma.membership.findMany({
        where: { organizationId, status: { in: ['ACTIVE', 'PENDING'] } },
        select: { price: true, memberId: true },
      }),
    ]);

    const membershipByMember = new Map(
      memberships.map((m) => [m.memberId, Number(m.price)]),
    );

    const riskCounts: Record<RiskLevel, number> = {
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0,
    };

    let revenueAtRiskHigh = 0;
    let revenueAtRiskCritical = 0;

    for (const profile of riskProfiles) {
      riskCounts[profile.riskLevel]++;

      const memberRevenue = membershipByMember.get(profile.memberId) ?? 0;

      if (profile.riskLevel === 'HIGH') {
        revenueAtRiskHigh += memberRevenue;
      } else if (profile.riskLevel === 'CRITICAL') {
        revenueAtRiskCritical += memberRevenue;
      }
    }

    const riskDistribution: RiskDistribution[] = [
      {
        riskLevel: 'LOW',
        count: riskCounts.LOW,
        percentage:
          totalMembers > 0 ? (riskCounts.LOW / totalMembers) * 100 : 0,
      },
      {
        riskLevel: 'MEDIUM',
        count: riskCounts.MEDIUM,
        percentage:
          totalMembers > 0 ? (riskCounts.MEDIUM / totalMembers) * 100 : 0,
      },
      {
        riskLevel: 'HIGH',
        count: riskCounts.HIGH,
        percentage:
          totalMembers > 0 ? (riskCounts.HIGH / totalMembers) * 100 : 0,
      },
      {
        riskLevel: 'CRITICAL',
        count: riskCounts.CRITICAL,
        percentage:
          totalMembers > 0 ? (riskCounts.CRITICAL / totalMembers) * 100 : 0,
      },
    ];

    return {
      totalMembers,
      riskDistribution,
      highRiskCount: riskCounts.HIGH,
      criticalRiskCount: riskCounts.CRITICAL,
      revenueAtRisk: revenueAtRiskHigh + revenueAtRiskCritical,
      revenueAtRiskByLevel: {
        HIGH: revenueAtRiskHigh,
        CRITICAL: revenueAtRiskCritical,
      },
    };
  }

  async getRiskTrend(
    organizationId: string,
    days: number = 30,
  ): Promise<RiskTrendPoint[]> {
    const now = Date.now();
    const startDate = new Date(now - days * 24 * 60 * 60 * 1000);

    const historicalProfiles = await this.prisma.memberRiskProfile.findMany({
      where: {
        organizationId,
        computedAt: { gte: startDate },
      },
      select: {
        overallScore: true,
        riskLevel: true,
        computedAt: true,
      },
      orderBy: { computedAt: 'asc' },
    });

    const dailyMap = new Map<
      string,
      { scores: number[]; high: number; critical: number; total: number }
    >();

    for (const profile of historicalProfiles) {
      const dateKey = profile.computedAt.toISOString().split('T')[0];
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { scores: [], high: 0, critical: 0, total: 0 });
      }
      const day = dailyMap.get(dateKey)!;
      day.scores.push(profile.overallScore);
      day.total++;
      if (profile.riskLevel === 'HIGH') day.high++;
      if (profile.riskLevel === 'CRITICAL') day.critical++;
    }

    const trend: RiskTrendPoint[] = [];
    for (const [date, data] of dailyMap.entries()) {
      const avgScore =
        data.scores.length > 0
          ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length
          : 0;
      trend.push({
        date,
        avgScore: Math.round(avgScore * 10) / 10,
        highRiskCount: data.high,
        criticalRiskCount: data.critical,
      });
    }

    return trend.sort((a, b) => a.date.localeCompare(b.date));
  }

  async getRevenueAtRisk(
    organizationId: string,
    _branchScope?: string,
  ): Promise<RevenueAtRisk> {
    const [activeMemberships, riskProfiles] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId, status: { in: ['ACTIVE', 'PENDING'] } },
        select: { price: true, memberId: true },
      }),
      this.prisma.memberRiskProfile.findMany({
        where: { organizationId },
        select: { memberId: true, riskLevel: true, overallScore: true },
      }),
    ]);

    type RiskProfileLite = {
      memberId: string;
      riskLevel: RiskLevel;
      overallScore: number;
    };
    const riskByMember = new Map<string, RiskProfileLite>(
      riskProfiles.map((r) => [r.memberId, r as RiskProfileLite]),
    );

    let totalMRR = 0;
    let atRiskMRR = 0;
    const bySegment: Record<RiskLevel, { mrr: number; memberCount: number }> = {
      LOW: { mrr: 0, memberCount: 0 },
      MEDIUM: { mrr: 0, memberCount: 0 },
      HIGH: { mrr: 0, memberCount: 0 },
      CRITICAL: { mrr: 0, memberCount: 0 },
    };

    for (const membership of activeMemberships) {
      const mrr = Number(membership.price);
      totalMRR += mrr;

      const risk = riskByMember.get(membership.memberId);
      if (
        risk &&
        (risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL')
      ) {
        atRiskMRR += mrr;
        bySegment[risk.riskLevel].mrr += mrr;
        bySegment[risk.riskLevel].memberCount++;
      } else if (risk) {
        bySegment[risk.riskLevel].mrr += mrr;
        bySegment[risk.riskLevel].memberCount++;
      }
    }

    return {
      totalMRR,
      atRiskMRR,
      atRiskPercentage: totalMRR > 0 ? (atRiskMRR / totalMRR) * 100 : 0,
      bySegment: (['HIGH', 'CRITICAL', 'MEDIUM', 'LOW'] as RiskLevel[]).map(
        (level) => ({
          riskLevel: level,
          mrr: bySegment[level].mrr,
          memberCount: bySegment[level].memberCount,
        }),
      ),
    };
  }

  async getBranchRiskSummary(
    organizationId: string,
  ): Promise<BranchRiskSummary[]> {
    const branches = await this.prisma.branch.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });

    const riskProfiles = await this.prisma.memberRiskProfile.findMany({
      where: { organizationId },
      select: {
        riskLevel: true,
        overallScore: true,
        member: { select: { primaryBranchId: true } },
      },
    });

    const riskByBranch = new Map<
      string,
      { scores: number[]; counts: Record<RiskLevel, number> }
    >();

    for (const branch of branches) {
      riskByBranch.set(branch.id, {
        scores: [],
        counts: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 },
      });
    }

    for (const profile of riskProfiles) {
      const branchId = profile.member.primaryBranchId;
      if (!riskByBranch.has(branchId)) continue;
      const branch = riskByBranch.get(branchId)!;
      branch.scores.push(profile.overallScore);
      branch.counts[profile.riskLevel]++;
    }

    const summaries: BranchRiskSummary[] = [];

    for (const branch of branches) {
      const data = riskByBranch.get(branch.id)!;
      const total = data.scores.length;
      const avgScore =
        total > 0 ? data.scores.reduce((a, b) => a + b, 0) / total : 0;

      const riskDistribution: RiskDistribution[] = (
        ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as RiskLevel[]
      ).map((level) => ({
        riskLevel: level,
        count: data.counts[level],
        percentage: total > 0 ? (data.counts[level] / total) * 100 : 0,
      }));

      summaries.push({
        branchId: branch.id,
        branchName: branch.name,
        totalMembers: total,
        riskDistribution,
        avgRiskScore: Math.round(avgScore * 10) / 10,
      });
    }

    return summaries.sort((a, b) => b.avgRiskScore - a.avgRiskScore);
  }
}
