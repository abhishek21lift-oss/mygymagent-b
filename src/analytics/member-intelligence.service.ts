import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const AT_RISK_THRESHOLD_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AtRiskMember {
  id: string;
  firstName: string;
  lastName: string;
  daysSinceLastVisit: number;
  /// True if daysSinceLastVisit is measured from joinedAt because the
  /// member has never checked in at all, not from a real visit -- the
  /// "why" a caller needs to not misread a brand-new member as at-risk
  /// for the wrong reason.
  neverCheckedIn: boolean;
}

export interface MemberStatusBreakdown {
  status: string;
  count: number;
}

/**
 * "What's likely to happen" on top of P1's "what happened" -- real,
 * explainable numbers (every figure traces back to Attendance/Member
 * rows a human could re-derive by hand), not a black-box score.
 */
@Injectable()
export class MemberIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  /// Deliberately a lower/earlier threshold than
  /// MemberInactiveScanner's 30-day automation trigger (src/automation/) --
  /// this is a "watch list" a staff member can act on before the
  /// automated recovery email even fires, not a duplicate of it.
  async getAtRiskMembers(
    organizationId: string,
    branchScope: string | null,
  ): Promise<AtRiskMember[]> {
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        joinedAt: true,
        attendances: {
          orderBy: { checkInAt: 'desc' },
          take: 1,
          select: { checkInAt: true },
        },
      },
    });

    const now = Date.now();
    const atRisk: AtRiskMember[] = [];
    for (const member of members) {
      const lastVisit = member.attendances[0]?.checkInAt;
      const reference = lastVisit ?? member.joinedAt;
      const daysSinceLastVisit = Math.floor(
        (now - reference.getTime()) / MS_PER_DAY,
      );
      if (daysSinceLastVisit < AT_RISK_THRESHOLD_DAYS) continue;
      atRisk.push({
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        daysSinceLastVisit,
        neverCheckedIn: !lastVisit,
      });
    }

    return atRisk.sort((a, b) => b.daysSinceLastVisit - a.daysSinceLastVisit);
  }

  async getStatusBreakdown(
    organizationId: string,
    branchScope: string | null,
  ): Promise<MemberStatusBreakdown[]> {
    const rows = await this.prisma.member.groupBy({
      by: ['status'],
      where: {
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      _count: true,
    });
    return rows.map((row) => ({ status: row.status, count: row._count }));
  }
}
