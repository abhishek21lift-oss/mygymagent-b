import {
  organizationTimezone,
  startOfZonedMonth,
  zonedBound,
  zonedMonthKey,
} from '../common/time/zoned';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface RevenueByCurrency {
  currency: string;
  paymentCount: number;
  grossRevenue: string;
  /// Payments linked to a Membership (new sign-ups, renewals).
  membershipRevenue: string;
  /// grossRevenue - membershipRevenue. Deliberately not split further
  /// into PT/product/other -- see notComputable below for why.
  otherRevenue: string;
  /// Counter sales of products (inventory), net of nothing -- their
  /// returns are in `refunded`. Sales raised on an invoice are left out:
  /// that money arrives as a payment and is already in grossRevenue.
  productRevenue: string;
  refunded: string;
  netRevenue: string;
}

export interface OutstandingByCurrency {
  currency: string;
  membershipsWithBalance: number;
  outstandingBalance: string;
}

export interface OutstandingMembership {
  membershipId: string;
  status: string;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
  planName: string | null;
  branch: { id: string; name: string } | null;
  startDate: Date;
  endDate: Date;
  currency: string;
  price: string;
  /// Net of refunds.
  paid: string;
  outstanding: string;
}

/// Request-scoped reuse for the current-state outstanding snapshot.
/// Created per top-level aggregation call (one Map per briefing/health
/// request), keyed by organization + branch. Never shared across
/// requests, so no cross-tenant leakage; no TTL/invalidation because the
/// Map dies with the request. Stores the in-flight promise so concurrent
/// callers in one Promise.all coalesce onto a single query.
export type OutstandingScopeCache = Map<
  string,
  Promise<OutstandingMembership[]>
>;

function outstandingCacheKey(
  organizationId: string,
  branchScope: string | null,
): string {
  return `${organizationId}::${branchScope ?? 'all'}`;
}

interface NotComputable {
  key: string;
  reason: string;
}

export interface RevenueSummary {
  period: { from: string; to: string };
  branchId: string | null;
  /// One entry per currency actually seen in the period -- summing
  /// across currencies would silently produce a meaningless number
  /// (Payment.currency/Membership.currency are per-record, not fixed
  /// per organization, so a single org can legitimately have payments
  /// in more than one currency).
  revenue: RevenueByCurrency[];
  /// Snapshot as of now, not scoped to `period` -- an outstanding
  /// balance is a current-state fact ("this membership is short-paid
  /// today"), not something that happened within a date range.
  outstanding: OutstandingByCurrency[];
  notComputable: NotComputable[];
}

interface RevenueMonth {
  currency: string;
  grossRevenue: string;
  productRevenue: string;
  refunded: string;
  netRevenue: string;
}

export interface RevenueTrendMonth {
  /// UTC calendar month, "YYYY-MM".
  month: string;
  revenue: RevenueMonth[];
}

const NOT_COMPUTABLE: NotComputable[] = [
  {
    key: 'ptRevenue',
    reason:
      "No PT session/package data model exists (see src/automation/README.md's PT-expiry note for the same gap) -- a Payment not linked to a membership could be a PT session, a product, or something else, with no field distinguishing which.",
  },
  {
    key: 'discounts',
    reason:
      'Payment/Membership have no discount or list-price field -- price is recorded net, with no record of what was waived.',
  },
  {
    key: 'expenses',
    reason:
      'Expenses are tracked separately (Expenses, GET /expenses/summary) and are not netted into this revenue summary.',
  },
  {
    key: 'payroll',
    reason:
      'Payroll runs are tracked separately (HR payroll) and are not netted into this revenue summary.',
  },
  {
    key: 'commissions',
    reason:
      'StaffProfile.commissionRate exists, but no Payment or Membership records which staff member should earn commission on it -- the rate has nothing to apply it to.',
  },
];

/**
 * The "centralized financial intelligence layer" the master prompt asks
 * for -- one place real revenue/outstanding-balance numbers are computed
 * from actual Payment/Refund/Membership rows, so every caller (this
 * module's controller today; a future dashboard or AI tool later) gets
 * the same honest numbers instead of each reinventing the math. See
 * NOT_COMPUTABLE above and this module's README for what's deliberately
 * left out rather than approximated.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getRevenueSummary(
    organizationId: string,
    query: { from?: string; to?: string },
    branchScope: string | null,
    outstandingCache?: OutstandingScopeCache,
  ): Promise<RevenueSummary> {
    const { from, to } = resolvePeriod(
      query,
      await organizationTimezone(this.prisma, organizationId),
    );
    // Payment.amount is always the original charge regardless of refund
    // status (refunds are tracked separately and never mutate it -- see
    // the Payment model comment), so refunded payments count toward gross
    // revenue and refunds are subtracted below to get net. FAILED ones
    // collected nothing and never count -- they used to.
    const paymentWhere = {
      organizationId,
      status: { not: 'FAILED' as const },
      createdAt: { gte: from, lt: to },
      ...(branchScope ? { branchId: branchScope } : {}),
    };

    const [grossByCurrency, membershipByCurrency, refunds] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['currency'],
        where: paymentWhere,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.payment.groupBy({
        by: ['currency'],
        where: { ...paymentWhere, membershipId: { not: null } },
        _sum: { amount: true },
      }),
      this.prisma.refund.findMany({
        where: {
          organizationId,
          createdAt: { gte: from, lt: to },
          ...(branchScope ? { payment: { branchId: branchScope } } : {}),
        },
        select: { amount: true, payment: { select: { currency: true } } },
      }),
    ]);

    const refundedByCurrency = new Map<string, number>();
    for (const refund of refunds) {
      const currency = refund.payment.currency;
      refundedByCurrency.set(
        currency,
        (refundedByCurrency.get(currency) ?? 0) + Number(refund.amount),
      );
    }
    const membershipRevenueByCurrency = new Map(
      membershipByCurrency.map((row) => [
        row.currency,
        Number(row._sum.amount ?? 0),
      ]),
    );

    const products = await this.productSalesByCurrency(
      organizationId,
      { gte: from, lt: to },
      branchScope,
    );
    const currencies = new Set([
      ...grossByCurrency.map((row) => row.currency),
      ...products.keys(),
    ]);
    const revenue: RevenueByCurrency[] = [...currencies].map((currency) => {
      const row = grossByCurrency.find((r) => r.currency === currency);
      const payments = Number(row?._sum.amount ?? 0);
      const product = products.get(currency) ?? { sold: 0, returned: 0 };
      const membership = membershipRevenueByCurrency.get(currency) ?? 0;
      const refunded =
        (refundedByCurrency.get(currency) ?? 0) + product.returned;
      const gross = payments + product.sold;
      return {
        currency,
        paymentCount: row?._count ?? 0,
        grossRevenue: gross.toFixed(2),
        membershipRevenue: membership.toFixed(2),
        otherRevenue: (payments - membership).toFixed(2),
        productRevenue: product.sold.toFixed(2),
        refunded: refunded.toFixed(2),
        netRevenue: (gross - refunded).toFixed(2),
      };
    });

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      branchId: branchScope,
      revenue,
      outstanding: await this.getOutstandingBalances(
        organizationId,
        branchScope,
        outstandingCache,
      ),
      notComputable: NOT_COMPUTABLE,
    };
  }

  /// One entry per UTC calendar month, oldest first -- the "is revenue
  /// growing" trend a caller needs a series for, not a single-period
  /// snapshot. Deliberately a separate, leaner query per month (gross/
  /// refunded/net only) rather than calling getRevenueSummary() in a
  /// loop -- that would recompute the *current* outstanding-balance
  /// snapshot and repeat the identical notComputable array `months`
  /// times over, neither of which varies per historical month.
  async getRevenueTrend(
    organizationId: string,
    branchScope: string | null,
    months: number,
  ): Promise<RevenueTrendMonth[]> {
    const now = new Date();
    // The gym's calendar months: a UTC month starts at 05:30 on the 1st in
    // India, so the first hours of every month were counted in the last.
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const monthStarts = Array.from({ length: months }, (_, i) =>
      startOfZonedMonth(now, timezone, months - 1 - i),
    );

    return Promise.all(
      monthStarts.map(async (start, i) => {
        const end = startOfZonedMonth(now, timezone, months - 2 - i);
        const paymentWhere = {
          organizationId,
          status: { not: 'FAILED' as const },
          createdAt: { gte: start, lt: end },
          ...(branchScope ? { branchId: branchScope } : {}),
        };

        const [gross, refunds] = await Promise.all([
          this.prisma.payment.groupBy({
            by: ['currency'],
            where: paymentWhere,
            _sum: { amount: true },
          }),
          this.prisma.refund.findMany({
            where: {
              organizationId,
              createdAt: { gte: start, lt: end },
              ...(branchScope ? { payment: { branchId: branchScope } } : {}),
            },
            select: { amount: true, payment: { select: { currency: true } } },
          }),
        ]);

        const refundedByCurrency = new Map<string, number>();
        for (const refund of refunds) {
          const currency = refund.payment.currency;
          refundedByCurrency.set(
            currency,
            (refundedByCurrency.get(currency) ?? 0) + Number(refund.amount),
          );
        }

        const products = await this.productSalesByCurrency(
          organizationId,
          { gte: start, lt: end },
          branchScope,
        );
        const currencies = new Set([
          ...gross.map((row) => row.currency),
          ...products.keys(),
        ]);
        const revenue: RevenueMonth[] = [...currencies].map((currency) => {
          const row = gross.find((r) => r.currency === currency);
          const product = products.get(currency) ?? { sold: 0, returned: 0 };
          const grossAmount = Number(row?._sum.amount ?? 0) + product.sold;
          const refunded =
            (refundedByCurrency.get(currency) ?? 0) + product.returned;
          return {
            currency,
            grossRevenue: grossAmount.toFixed(2),
            productRevenue: product.sold.toFixed(2),
            refunded: refunded.toFixed(2),
            netRevenue: (grossAmount - refunded).toFixed(2),
          };
        });

        return { month: zonedMonthKey(start, timezone), revenue };
      }),
    );
  }

  /**
   * Product sales at the counter, per currency: what was sold and what of
   * it came back. They never became Payment rows (a walk-in sale has no
   * member, and Payment needs one), so revenue left them out entirely.
   * Sales raised on an invoice are skipped -- that money is a payment.
   * A return has no date of its own, so it counts against its sale's
   * period; a cancelled sale counts for nothing.
   */
  private async productSalesByCurrency(
    organizationId: string,
    createdAt: { gte: Date; lt: Date },
    branchScope: string | null,
  ): Promise<Map<string, { sold: number; returned: number }>> {
    const sales = await this.prisma.inventorySale.findMany({
      where: {
        organizationId,
        invoiceId: null,
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
        createdAt,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: {
        currency: true,
        subtotal: true,
        total: true,
        items: {
          select: { unitPrice: true, returnedQuantity: true },
        },
      },
    });
    const byCurrency = new Map<string, { sold: number; returned: number }>();
    for (const sale of sales) {
      const entry = byCurrency.get(sale.currency) ?? { sold: 0, returned: 0 };
      const total = Number(sale.total);
      const subtotal = Number(sale.subtotal);
      // Returned goods at the price actually paid, discount included.
      const share = subtotal > 0 ? total / subtotal : 0;
      const returnedList = sale.items.reduce(
        (sum, item) => sum + Number(item.unitPrice) * item.returnedQuantity,
        0,
      );
      entry.sold += total;
      entry.returned += Math.round(returnedList * share * 100) / 100;
      byCurrency.set(sale.currency, entry);
    }
    return byCurrency;
  }

  /// Same "outstanding balance" definition PaymentOverdueScanner uses
  /// (membership.price minus net real payments against it), aggregated
  /// into per-currency totals instead of per-membership reminders --
  /// see that scanner's comment for why this isn't an invoice/due-date
  /// system.
  async getOutstandingBalances(
    organizationId: string,
    branchScope: string | null,
    outstandingCache?: OutstandingScopeCache,
  ): Promise<OutstandingByCurrency[]> {
    const rows = await this.listOutstandingMemberships(
      organizationId,
      branchScope,
      outstandingCache,
    );
    const byCurrency = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const entry = byCurrency.get(row.currency) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number(row.outstanding);
      byCurrency.set(row.currency, entry);
    }

    return Array.from(byCurrency.entries()).map(
      ([currency, { count, total }]) => ({
        currency,
        membershipsWithBalance: count,
        outstandingBalance: total.toFixed(2),
      }),
    );
  }

  /// Every membership with money still owed on it, largest first: the
  /// rows behind the "outstanding" totals above, so a list and the
  /// figure it explains can never disagree.
  async listOutstandingMemberships(
    organizationId: string,
    branchScope: string | null,
    outstandingCache?: OutstandingScopeCache,
  ): Promise<OutstandingMembership[]> {
    if (!outstandingCache) {
      return this.queryOutstandingMemberships(organizationId, branchScope);
    }
    const key = outstandingCacheKey(organizationId, branchScope);
    const cached = outstandingCache.get(key);
    if (cached) return cached;
    // Set synchronously so concurrent callers in one Promise.all share it.
    const pending = this.queryOutstandingMemberships(
      organizationId,
      branchScope,
    );
    outstandingCache.set(key, pending);
    // Don't poison later callers in this request if the query fails.
    pending.catch(() => outstandingCache.delete(key));
    return pending;
  }

  private async queryOutstandingMemberships(
    organizationId: string,
    branchScope: string | null,
  ): Promise<OutstandingMembership[]> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        status: { in: ['ACTIVE', 'PENDING'] },
        startDate: { lte: new Date() },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: {
        id: true,
        status: true,
        price: true,
        currency: true,
        startDate: true,
        endDate: true,
        membershipPlan: { select: { name: true } },
        branch: { select: { id: true, name: true } },
        member: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
        payments: {
          where: { status: { not: 'FAILED' } },
          select: { amount: true, refunds: { select: { amount: true } } },
        },
      },
    });

    const rows: OutstandingMembership[] = [];
    for (const membership of memberships) {
      const grossPaid = membership.payments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );
      const refunded = membership.payments
        .flatMap((p) => p.refunds)
        .reduce((sum, r) => sum + Number(r.amount), 0);
      const paid = grossPaid - refunded;
      const outstanding = Number(membership.price) - paid;
      if (outstanding <= 0) continue;
      rows.push({
        membershipId: membership.id,
        status: membership.status,
        member: membership.member,
        planName: membership.membershipPlan?.name ?? null,
        branch: membership.branch,
        startDate: membership.startDate,
        endDate: membership.endDate,
        currency: membership.currency,
        price: Number(membership.price).toFixed(2),
        paid: paid.toFixed(2),
        outstanding: outstanding.toFixed(2),
      });
    }
    return rows.sort((x, y) => Number(y.outstanding) - Number(x.outstanding));
  }
}

/// Defaults to the gym's current calendar month when the caller doesn't
/// specify a range -- the "this period" a revenue view would open to. A
/// bare date means that whole day in the gym's timezone; `to` is
/// exclusive (compared with `lt`).
function resolvePeriod(
  query: { from?: string; to?: string },
  timezone: string,
): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  const to = query.to
    ? zonedBound(query.to, timezone, 'to')
    : new Date(now.getTime() + 1);
  const from = query.from
    ? zonedBound(query.from, timezone, 'from')
    : startOfZonedMonth(now, timezone);
  return { from, to };
}
