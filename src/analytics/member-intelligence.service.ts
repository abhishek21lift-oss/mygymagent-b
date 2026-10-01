import { Injectable } from '@nestjs/common';
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
}
