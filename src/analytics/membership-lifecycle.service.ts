import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface MembershipLifecycle {
  statusCounts: { status: string; count: number }[];
  activePlanDistribution: {
    planId: string;
    planName: string;
    count: number;
  }[];
  /// Renewed-in-last-90d / all-created-in-last-90d, as a percentage
  /// string ("0.00" when nothing was created -- never NaN from a
  /// divide-by-zero). A "renewal" is a membership row linked via
  /// previousMembershipId, the chain renew()/upgrade flows write.
  renewalRatePct: string;
  /// Share of all memberships that ever used a freeze day.
  freezeUtilizationRatePct: string;
  expiringWithin30Days: number;
  newLast90Days: number;
  renewedLast90Days: number;
  /// Average (closedDate - startDate) in days over EXPIRED/CANCELLED
  /// memberships; null when there are none (0 would read as "everyone
  /// churns instantly").
  avgClosedTenureDays: number | null;
  outstandingByCurrency: {
    currency: string;
    membershipsWithBalance: number;
    outstandingBalance: string;
  }[];
}

export interface RenewalPipelineItem {
  membershipId: string;
  memberId: string;
  firstName: string;
  lastName: string;
  planName: string;
  /// Plan price at sale, Decimal-safe string; per-currency, never summed.
  price: string;
  currency: string;
  endDate: string;
  daysUntilExpiry: number;
}

export interface RenewalPipeline {
  upcoming: RenewalPipelineItem[];
  overdue: RenewalPipelineItem[];
  highValue: RenewalPipelineItem[];
  counts: { upcoming: number; overdue: number };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Membership lifecycle reporting, computed from real Membership/
 * MembershipPlan/Payment/Refund rows. Every figure traces back to rows
 * the memberships CRUD routes already manage -- this service only
 * aggregates, the same honesty discipline FinanceService uses (no
 * approximated splits, "0.00"/null instead of NaN, per-currency
 * buckets instead of cross-currency sums).
 */
@Injectable()
export class MembershipLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async getLifecycle(
    organizationId: string,
    branchScope: string | null,
  ): Promise<MembershipLifecycle> {
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * MS_PER_DAY);
    const days90Ago = new Date(now.getTime() - 90 * MS_PER_DAY);

    const [
      byStatus,
      activeByPlan,
      createdLast90,
      expiring,
      closed,
      freezeUsed,
      totalCount,
      activeWithPayments,
    ] = await Promise.all([
      this.prisma.membership.groupBy({
        by: ['status'],
        where: scoped,
        _count: true,
      }),
      this.prisma.membership.groupBy({
        by: ['membershipPlanId'],
        where: { ...scoped, status: 'ACTIVE' },
        _count: true,
      }),
      this.prisma.membership.findMany({
        where: { ...scoped, createdAt: { gte: days90Ago } },
        select: { previousMembershipId: true },
      }),
      this.prisma.membership.count({
        where: {
          ...scoped,
          status: 'ACTIVE',
          endDate: { gte: now, lte: in30Days },
        },
      }),
      this.prisma.membership.findMany({
        where: { ...scoped, status: { in: ['EXPIRED', 'CANCELLED'] } },
        select: {
          status: true,
          startDate: true,
          endDate: true,
          cancelledAt: true,
        },
      }),
      this.prisma.membership.count({
        where: { ...scoped, totalFreezeDaysUsed: { gt: 0 } },
      }),
      this.prisma.membership.count({ where: scoped }),
      this.prisma.membership.findMany({
        where: { ...scoped, status: 'ACTIVE' },
        select: {
          id: true,
          price: true,
          currency: true,
          payments: {
            select: {
              amount: true,
              refunds: { select: { amount: true } },
            },
          },
        },
      }),
    ]);

    const planIds = activeByPlan.map((row) => row.membershipPlanId);
    const plans = planIds.length
      ? await this.prisma.membershipPlan.findMany({
          where: { id: { in: planIds } },
          select: { id: true, name: true },
        })
      : [];
    const planNames = new Map(plans.map((p) => [p.id, p.name]));

    const renewedLast90Days = createdLast90.filter(
      (m) => m.previousMembershipId !== null,
    ).length;
    const newLast90Days = createdLast90.length - renewedLast90Days;

    const tenures = closed
      .map((m) => {
        const end =
          m.status === 'CANCELLED' && m.cancelledAt ? m.cancelledAt : m.endDate;
        return (end.getTime() - m.startDate.getTime()) / MS_PER_DAY;
      })
      .filter((days) => days >= 0);

    const byCurrency = new Map<
      string,
      { count: number; balance: Prisma.Decimal }
    >();
    for (const membership of activeWithPayments) {
      const paid = membership.payments.reduce(
        (sum, payment) =>
          sum.plus(
            payment.amount.sub(
              payment.refunds.reduce(
                (refundSum, refund) => refundSum.plus(refund.amount),
                new Prisma.Decimal(0),
              ),
            ),
          ),
        new Prisma.Decimal(0),
      );
      const balance = membership.price.sub(paid);
      if (balance.gt(0)) {
        const entry = byCurrency.get(membership.currency) ?? {
          count: 0,
          balance: new Prisma.Decimal(0),
        };
        entry.count += 1;
        entry.balance = entry.balance.plus(balance);
        byCurrency.set(membership.currency, entry);
      }
    }

    return {
      statusCounts: byStatus.map((row) => ({
        status: row.status,
        count: row._count,
      })),
      activePlanDistribution: activeByPlan.map((row) => ({
        planId: row.membershipPlanId,
        planName: planNames.get(row.membershipPlanId) ?? 'Unknown plan',
        count: row._count,
      })),
      renewalRatePct:
        createdLast90.length > 0
          ? ((renewedLast90Days / createdLast90.length) * 100).toFixed(2)
          : '0.00',
      freezeUtilizationRatePct:
        totalCount > 0 ? ((freezeUsed / totalCount) * 100).toFixed(2) : '0.00',
      expiringWithin30Days: expiring,
      newLast90Days,
      renewedLast90Days,
      avgClosedTenureDays:
        tenures.length > 0
          ? Math.round(
              (tenures.reduce((sum, days) => sum + days, 0) / tenures.length) *
                10,
            ) / 10
          : null,
      outstandingByCurrency: [...byCurrency.entries()].map(
        ([currency, entry]) => ({
          currency,
          membershipsWithBalance: entry.count,
          outstandingBalance: entry.balance.toFixed(2),
        }),
      ),
    };
  }

  /**
   * Renewal pipeline: who to contact now. Upcoming = ACTIVE terms ending
   * within 30 days (ordered soonest first, capped); overdue = terms that
   * expired in the last 30 days with no ACTIVE successor row; highValue =
   * top upcoming by price. Values are plan prices (Decimal-safe strings),
   * never summed across currencies here — callers bucket per currency.
   */
  async getRenewalPipeline(
    organizationId: string,
    branchScope: string | null,
  ): Promise<RenewalPipeline> {
    const now = new Date();
    const horizon = new Date(now.getTime() + 30 * MS_PER_DAY);
    const lookback = new Date(now.getTime() - 30 * MS_PER_DAY);
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [upcoming, recentlyExpired, activeMemberIds] = await Promise.all([
      this.prisma.membership.findMany({
        where: {
          ...scoped,
          status: 'ACTIVE',
          endDate: { gte: now, lte: horizon },
        },
        orderBy: { endDate: 'asc' },
        take: 50,
        include: {
          membershipPlan: { select: { name: true } },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.membership.findMany({
        where: {
          ...scoped,
          status: 'EXPIRED',
          endDate: { gte: lookback, lte: now },
        },
        orderBy: { endDate: 'desc' },
        take: 50,
        include: {
          membershipPlan: { select: { name: true } },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.membership
        .findMany({
          where: { ...scoped, status: 'ACTIVE' },
          select: { memberId: true },
        })
        .then((rows) => new Set(rows.map((r) => r.memberId))),
    ]);

    const toItem = (m: (typeof upcoming)[number]): RenewalPipelineItem => ({
      membershipId: m.id,
      memberId: m.member.id,
      firstName: m.member.firstName,
      lastName: m.member.lastName,
      planName: m.membershipPlan.name,
      price: m.price.toString(),
      currency: m.currency,
      endDate: m.endDate.toISOString(),
      daysUntilExpiry: Math.max(
        0,
        Math.ceil((m.endDate.getTime() - now.getTime()) / MS_PER_DAY),
      ),
    });
    // An expired term whose member holds no ACTIVE term is a lost renewal
    // until someone acts — members who already renewed are not "overdue".
    // Sorted here as well as in the query so the contract holds even if
    // the ordering clause ever changes.
    const overdue = recentlyExpired
      .filter((m) => !activeMemberIds.has(m.member.id))
      .map(toItem);
    const byExpiry = (items: RenewalPipelineItem[]) =>
      [...items].sort(
        (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime(),
      );
    const priced = (rows: (typeof upcoming)[number][]) =>
      rows
        .map(toItem)
        .sort((a, b) => Number(b.price) - Number(a.price))
        .slice(0, 5);
    return {
      upcoming: byExpiry(upcoming.map(toItem)),
      overdue: byExpiry(overdue),
      highValue: priced(upcoming),
      counts: { upcoming: upcoming.length, overdue: overdue.length },
    };
  }
}
