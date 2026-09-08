import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['ACTIVE', 'FROZEN', 'PAUSED'] as const;

/**
 * Membership lifecycle analytics over real data only: every number is a
 * database aggregate, never a guess. Anything not derivable from the
 * current schema is omitted rather than approximated.
 */
@Injectable()
export class MembershipLifecycleAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getLifecycle(organizationId: string, branchScope: string | null) {
    const branchFilter = branchScope ? { branchId: branchScope } : {};
    const where = { organizationId, ...branchFilter };
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * MS_PER_DAY);
    const days90Ago = new Date(now.getTime() - 90 * MS_PER_DAY);

    const [
      statusCounts,
      activePlanDistribution,
      renewalChains,
      expiredCount,
      freezeUtilization,
      expiringWithin30,
      createdLast90,
      outstandingRows,
    ] = await Promise.all([
      this.prisma.membership.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.membership.groupBy({
        by: ['membershipPlanId'],
        where: { ...where, status: { in: [...ACTIVE_STATUSES] } },
        _count: { _all: true },
      }),
      this.prisma.membership.findMany({
        where: { ...where, previousMembershipId: { not: null } },
        select: {
          createdAt: true,
          startDate: true,
          previousMembershipId: true,
        },
      }),
      this.prisma.membership.count({ where: { ...where, status: 'EXPIRED' } }),
      this.prisma.membership.findMany({
        where: { ...where, status: { in: [...ACTIVE_STATUSES] } },
        select: {
          totalFreezeDaysUsed: true,
          membershipPlan: { select: { maxFreezeDays: true } },
        },
      }),
      this.prisma.membership.count({
        where: {
          ...where,
          status: { in: [...ACTIVE_STATUSES] },
          endDate: { gte: now, lte: in30Days },
        },
      }),
      this.prisma.membership.findMany({
        where: { ...where, createdAt: { gte: days90Ago } },
        select: { previousMembershipId: true, startDate: true },
      }),
      this.getOutstandingByCurrency(organizationId, branchScope),
    ]);

    // Renewal rate: members whose expired/cancelled membership was
    // followed by a chained renewal row, over all expired memberships.
    const renewedCount = renewalChains.length;
    const renewalRate =
      expiredCount + renewedCount > 0
        ? Number(
            (renewedCount / Math.max(1, expiredCount + renewedCount)).toFixed(
              4,
            ),
          )
        : 0;

    // Freeze utilization across live memberships.
    const freezeEligible = freezeUtilization.filter(
      (m) => m.membershipPlan.maxFreezeDays > 0,
    );
    const totalQuota = freezeEligible.reduce(
      (sum, m) => sum + m.membershipPlan.maxFreezeDays,
      0,
    );
    const totalUsed = freezeUtilization.reduce(
      (sum, m) => sum + m.totalFreezeDaysUsed,
      0,
    );
    const freezeUtilizationRate =
      totalQuota > 0 ? Number((totalUsed / totalQuota).toFixed(4)) : 0;

    // New vs renewed in the last 90 days.
    const newLast90 = createdLast90.filter(
      (m) => !m.previousMembershipId,
    ).length;
    const renewedLast90 = createdLast90.filter(
      (m) => m.previousMembershipId,
    ).length;

    // Average tenure of closed (expired or cancelled) memberships.
    const closedTenures = await this.prisma.membership.findMany({
      where: { ...where, status: { in: ['EXPIRED', 'CANCELLED'] } },
      select: { startDate: true, endDate: true },
    });
    const avgTenureDays =
      closedTenures.length > 0
        ? Number(
            (
              closedTenures.reduce(
                (sum, m) =>
                  sum +
                  Math.max(
                    0,
                    (m.endDate.getTime() - m.startDate.getTime()) / MS_PER_DAY,
                  ),
                0,
              ) / closedTenures.length
            ).toFixed(1),
          )
        : 0;

    const planNames = await this.prisma.membershipPlan.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const planNameById = new Map(planNames.map((p) => [p.id, p.name]));

    return {
      statusCounts: statusCounts.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      activePlanDistribution: activePlanDistribution.map((row) => ({
        planId: row.membershipPlanId,
        planName: planNameById.get(row.membershipPlanId) ?? 'Unknown',
        count: row._count._all,
      })),
      renewalRate,
      renewedCount,
      expiredCount,
      freezeUtilizationRate,
      totalFreezeQuotaDays: totalQuota,
      totalFreezeDaysUsed: totalUsed,
      expiringWithin30Days: expiringWithin30,
      newLast90Days: newLast90,
      renewedLast90Days: renewedLast90,
      avgClosedTenureDays: avgTenureDays,
      outstandingByCurrency: outstandingRows,
    };
  }

  /** Outstanding balances per currency, computed the same way as
   * MembershipsService.getOutstandingBalance: due minus completed
   * payments plus refunds. */
  private async getOutstandingByCurrency(
    organizationId: string,
    branchScope: string | null,
  ) {
    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: { id: true, price: true, currency: true },
    });
    if (memberships.length === 0) return [];

    const membershipIds = memberships.map((m) => m.id);
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          organizationId,
          membershipId: { in: membershipIds },
          status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] },
        },
        select: { membershipId: true, amount: true },
      }),
      this.prisma.refund.findMany({
        where: {
          payment: {
            organizationId,
            membershipId: { in: membershipIds },
          },
        },
        select: { amount: true, payment: { select: { membershipId: true } } },
      }),
    ]);

    const paidByMembership = new Map<string, Prisma.Decimal>();
    for (const payment of payments) {
      const current =
        paidByMembership.get(payment.membershipId!) ?? new Prisma.Decimal(0);
      paidByMembership.set(payment.membershipId!, current.plus(payment.amount));
    }
    const refundedByMembership = new Map<string, Prisma.Decimal>();
    for (const refund of refunds) {
      const key = refund.payment.membershipId!;
      const current = refundedByMembership.get(key) ?? new Prisma.Decimal(0);
      refundedByMembership.set(key, current.plus(refund.amount));
    }

    const byCurrency = new Map<string, Prisma.Decimal>();
    for (const membership of memberships) {
      const paid = paidByMembership.get(membership.id) ?? new Prisma.Decimal(0);
      const refunded =
        refundedByMembership.get(membership.id) ?? new Prisma.Decimal(0);
      const outstanding = membership.price.sub(paid).add(refunded);
      if (outstanding.lte(0)) continue;
      const current =
        byCurrency.get(membership.currency) ?? new Prisma.Decimal(0);
      byCurrency.set(membership.currency, current.plus(outstanding));
    }

    return Array.from(byCurrency.entries()).map(([currency, amount]) => ({
      currency,
      amount: amount.toFixed(2),
    }));
  }
}
