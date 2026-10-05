import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const AT_RISK_THRESHOLD_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A membership term running today: the same test the access gate uses
 * (AttendanceService.evaluateGate). A sold renewal is ACTIVE too, but
 * starts in the future, so the date bounds matter. */
export function currentTermWhere(now: Date) {
  return {
    status: 'ACTIVE' as const,
    startDate: { lte: now },
    endDate: { gte: now },
  };
}

export type EffectiveMemberStatus =
  'ACTIVE' | 'FROZEN' | 'UPCOMING' | 'EXPIRED' | 'NO_MEMBERSHIP' | 'INACTIVE';

const STATUS_ORDER: EffectiveMemberStatus[] = [
  'ACTIVE',
  'FROZEN',
  'UPCOMING',
  'EXPIRED',
  'NO_MEMBERSHIP',
  'INACTIVE',
];

export function effectiveMemberStatus(
  member: {
    status: string;
    memberships: { status: string; startDate: Date; endDate: Date }[];
  },
  now: Date,
): EffectiveMemberStatus {
  if (member.status === 'INACTIVE') return 'INACTIVE';
  const terms = member.memberships.filter((t) => t.status !== 'CANCELLED');
  if (terms.length === 0) return 'NO_MEMBERSHIP';
  const t = now.getTime();
  if (
    terms.some(
      (term) =>
        term.status === 'ACTIVE' &&
        term.startDate.getTime() <= t &&
        term.endDate.getTime() >= t,
    )
  ) {
    return 'ACTIVE';
  }
  if (terms.some((term) => term.status === 'FROZEN')) return 'FROZEN';
  if (
    terms.some(
      (term) =>
        (term.status === 'ACTIVE' || term.status === 'PENDING') &&
        term.startDate.getTime() > t,
    )
  ) {
    return 'UPCOMING';
  }
  return 'EXPIRED';
}

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

export interface PtAdherence {
  memberId: string;
  windowDays: number;
  /// Completed / (completed + cancelled + no-show) over 90 days, null
  /// when fewer than 3 decided sessions — a percentage off two sessions
  /// is noise, not adherence.
  ptAdherencePct: number | null;
  workoutsCompleted30d: number;
  visits30d: number;
  /// Consecutive weeks (up to 12) ending this week with ≥1 admitted visit.
  weeklyStreak: number;
  insufficientData: boolean;
}

export type WinBackTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WinBackCandidate {
  memberId: string;
  firstName: string;
  lastName: string;
  /// Whole days since the last term ended.
  daysSinceExpiry: number;
  /// Sum of COMPLETED payment amounts (Decimal-safe string).
  lifetimePaid: string;
  currency: string;
  /// Sum of closed-term lengths in days.
  tenureDays: number;
  /// Last admitted visit, null when they never checked in.
  lastVisitAt: string | null;
  priorPtPackages: number;
  tier: WinBackTier;
  /// Evidence lines, e.g. "Paid ₹45,000 over 210 days".
  reasons: string[];
}

export interface WinBackList {
  items: WinBackCandidate[];
  counts: { high: number; medium: number; low: number };
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
  ///
  /// At risk means *paying and not coming*: a current membership term
  /// and no admitted visit for AT_RISK_THRESHOLD_DAYS. Two things used to
  /// distort it. `Member.status` stays ACTIVE after the membership lapses
  /// (nothing moves it with time), so lapsed members -- already churned,
  /// a sales problem rather than a retention one -- swelled the count.
  /// And a denied attempt at the door was read as a visit, so the member
  /// turned away for an unpaid bill dropped off the list at the moment
  /// they most needed a call.
  async getAtRiskMembers(
    organizationId: string,
    branchScope: string | null,
  ): Promise<AtRiskMember[]> {
    const now = new Date();
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        status: { not: 'INACTIVE' },
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        memberships: { some: currentTermWhere(now) },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        joinedAt: true,
        attendances: {
          where: { deniedReason: null },
          orderBy: { checkInAt: 'desc' },
          take: 1,
          select: { checkInAt: true },
        },
      },
    });

    const atRisk: AtRiskMember[] = [];
    for (const member of members) {
      const lastVisit = member.attendances[0]?.checkInAt;
      const reference = lastVisit ?? member.joinedAt;
      const daysSinceLastVisit = Math.floor(
        (now.getTime() - reference.getTime()) / MS_PER_DAY,
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

  /// Members by where their membership actually stands today, derived
  /// from Membership terms rather than `Member.status`. The hourly
  /// MembershipStatusScanner expires Membership rows and nothing else, so
  /// grouping by `Member.status` showed every lapsed member as ACTIVE for
  /// ever. The one manual status still honoured is INACTIVE: staff set it
  /// on purpose, and it outranks whatever the terms say.
  ///
  ///  - ACTIVE        a term covers today
  ///  - FROZEN        no running term, but a frozen one
  ///  - UPCOMING      only a term that has not started yet
  ///  - EXPIRED       had terms, none current or upcoming
  ///  - NO_MEMBERSHIP never bought one (cancelled terms do not count)
  async getStatusBreakdown(
    organizationId: string,
    branchScope: string | null,
  ): Promise<MemberStatusBreakdown[]> {
    const now = new Date();
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: {
        status: true,
        memberships: {
          where: { status: { not: 'CANCELLED' } },
          select: { status: true, startDate: true, endDate: true },
        },
      },
    });

    const counts = new Map<EffectiveMemberStatus, number>();
    for (const member of members) {
      const status = effectiveMemberStatus(member, now);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return STATUS_ORDER.filter((status) => counts.has(status)).map(
      (status) => ({ status, count: counts.get(status)! }),
    );
  }

  /**
   * Win-back candidates: lapsed members worth re-engaging, ranked by
   * proven value. Lapsed = effective status EXPIRED with the last term
   * over 30 days old (recent churn belongs to renewals, not win-back;
   * members who never bought are prospects, not win-back). Value tiers
   * are relative — top 20% of this org's lapsed base by lifetime COMPLETED
   * payments is HIGH — so no currency-amount magic numbers. Capped;
   * counts cover the ranked set.
   */
  async getWinBackCandidates(
    organizationId: string,
    branchScope: string | null,
  ): Promise<WinBackList> {
    const now = new Date();
    const lapsedBefore = new Date(now.getTime() - 30 * MS_PER_DAY);
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        memberships: { some: { status: { not: 'CANCELLED' } } },
      },
      take: 500,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        memberships: {
          where: { status: { not: 'CANCELLED' } },
          select: { status: true, startDate: true, endDate: true },
        },
        riskProfile: { select: { riskLevel: true } },
      },
    });

    const lapsed = members.filter((m) => {
      if (effectiveMemberStatus(m, now) !== 'EXPIRED') return false;
      const lastEnd = Math.max(
        ...m.memberships.map((t) => t.endDate.getTime()),
      );
      return lastEnd < lapsedBefore.getTime();
    });
    if (lapsed.length === 0) {
      return { items: [], counts: { high: 0, medium: 0, low: 0 } };
    }
    const ids = lapsed.map((m) => m.id);
    const [payments, visits, ptCounts] = await Promise.all([
      this.prisma.payment.findMany({
        where: { organizationId, memberId: { in: ids }, status: 'COMPLETED' },
        select: {
          memberId: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
      }),
      this.prisma.attendance.groupBy({
        by: ['memberId'],
        where: { organizationId, memberId: { in: ids }, deniedReason: null },
        _max: { checkInAt: true },
      }),
      this.prisma.ptPackage.groupBy({
        by: ['memberId'],
        where: { organizationId, memberId: { in: ids } },
        _count: true,
      }),
    ]);

    const paidByMember = new Map<string, { total: number; currency: string }>();
    for (const p of payments) {
      const entry = paidByMember.get(p.memberId) ?? {
        total: 0,
        currency: p.currency,
      };
      entry.total += Number(p.amount);
      // Currency follows the most recent payment — mixed-currency orgs
      // rank on the latest denomination, documented, never converted.
      entry.currency = p.currency;
      paidByMember.set(p.memberId, entry);
    }
    const visitByMember = new Map(
      visits.map((v) => [v.memberId, v._max.checkInAt]),
    );
    const ptByMember = new Map(ptCounts.map((r) => [r.memberId, r._count]));

    const ranked = lapsed
      .map((m) => {
        const lastEnd = Math.max(
          ...m.memberships.map((t) => t.endDate.getTime()),
        );
        const tenureDays = Math.max(
          0,
          Math.round(
            m.memberships.reduce(
              (sum, t) =>
                sum +
                Math.max(
                  0,
                  (Math.min(t.endDate.getTime(), now.getTime()) -
                    t.startDate.getTime()) /
                    MS_PER_DAY,
                ),
              0,
            ),
          ),
        );
        const paid = paidByMember.get(m.id) ?? { total: 0, currency: '' };
        const lastVisit = visitByMember.get(m.id) ?? null;
        return { m, lastEnd, tenureDays, paid, lastVisit };
      })
      .sort((a, b) => b.paid.total - a.paid.total)
      .slice(0, 100);

    const highCut = Math.max(1, Math.ceil(ranked.length * 0.2));
    const mediumCut = highCut + Math.ceil(ranked.length * 0.3);
    const items: WinBackCandidate[] = ranked.map((entry, index) => {
      const { m, lastEnd, tenureDays, paid, lastVisit } = entry;
      const daysSinceExpiry = Math.max(
        0,
        Math.floor((now.getTime() - lastEnd) / MS_PER_DAY),
      );
      const ptPackages = ptByMember.get(m.id) ?? 0;
      const reasons = [
        `Paid ${paid.total.toLocaleString()}${paid.currency ? ` ${paid.currency}` : ''} over ${tenureDays} days`,
        lastVisit
          ? `Last visit ${Math.floor((now.getTime() - lastVisit.getTime()) / MS_PER_DAY)} days ago`
          : 'Never checked in',
      ];
      if (ptPackages > 0) reasons.push(`${ptPackages} prior PT packages`);
      if (
        m.riskProfile &&
        (m.riskProfile.riskLevel === 'HIGH' ||
          m.riskProfile.riskLevel === 'CRITICAL')
      ) {
        reasons.push(`Was ${m.riskProfile.riskLevel} risk before lapsing`);
      }
      return {
        memberId: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        daysSinceExpiry,
        lifetimePaid: paid.total.toFixed(2),
        currency: paid.currency,
        tenureDays,
        lastVisitAt: lastVisit ? lastVisit.toISOString() : null,
        priorPtPackages: ptPackages,
        tier: (index < highCut
          ? 'HIGH'
          : index < mediumCut
            ? 'MEDIUM'
            : 'LOW') as WinBackTier,
        reasons,
      };
    });
    return {
      items,
      counts: {
        high: items.filter((i) => i.tier === 'HIGH').length,
        medium: items.filter((i) => i.tier === 'MEDIUM').length,
        low: items.filter((i) => i.tier === 'LOW').length,
      },
    };
  }

  /**
   * PT adherence from records, not estimates. PT completion rate over 90
   * days (null under 3 decided sessions), workouts completed and admitted
   * visits over 30 days, plus a capped weekly visit streak. Assignment-
   * and branch-scoped like the workout history reads.
   */
  async getPtAdherence(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<PtAdherence> {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    const now = new Date();
    const since90 = new Date(now.getTime() - 90 * MS_PER_DAY);
    const since30 = new Date(now.getTime() - 30 * MS_PER_DAY);
    const since84 = new Date(now.getTime() - 84 * MS_PER_DAY);
    const [ptOutcomes, workouts30, visits30, visits84] = await Promise.all([
      this.prisma.ptSession.groupBy({
        by: ['status'],
        where: { organizationId, memberId, startTime: { gte: since90 } },
        _count: true,
      }),
      this.prisma.workoutSession.count({
        where: {
          organizationId,
          memberId,
          status: 'COMPLETED',
          sessionDate: { gte: since30 },
        },
      }),
      this.prisma.attendance.count({
        where: {
          organizationId,
          memberId,
          deniedReason: null,
          checkInAt: { gte: since30 },
        },
      }),
      this.prisma.attendance.findMany({
        where: {
          organizationId,
          memberId,
          deniedReason: null,
          checkInAt: { gte: since84 },
        },
        select: { checkInAt: true },
        orderBy: { checkInAt: 'asc' },
      }),
    ]);

    const decided = ptOutcomes
      .filter((r) => r.status !== 'SCHEDULED')
      .reduce((sum, r) => sum + r._count, 0);
    const completed =
      ptOutcomes.find((r) => r.status === 'COMPLETED')?._count ?? 0;
    const ptAdherencePct =
      decided >= 3 ? Math.round((completed / decided) * 100) : null;

    const weeks = new Set<string>();
    for (const visit of visits84) {
      const d = new Date(visit.checkInAt);
      const monday = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      weeks.add(monday.toISOString().slice(0, 10));
    }
    let weeklyStreak = 0;
    const cursor = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
    for (let i = 0; i < 12; i++) {
      if (!weeks.has(cursor.toISOString().slice(0, 10))) break;
      weeklyStreak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 7);
    }

    return {
      memberId,
      windowDays: 30,
      ptAdherencePct,
      workoutsCompleted30d: workouts30,
      visits30d: visits30,
      weeklyStreak,
      insufficientData:
        ptAdherencePct === null && workouts30 === 0 && visits30 === 0,
    };
  }
}
