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
  refunded: string;
  netRevenue: string;
}

interface OutstandingByCurrency {
  currency: string;
  membershipsWithBalance: number;
  outstandingBalance: string;
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
    key: 'productRevenue',
    reason:
      'StockMovement records quantity only, not price, and has no link to a Payment -- there is no way to know if or when a product sale was actually paid for, or at what price.',
  },
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
    reason: 'No expense-tracking model exists anywhere in this schema.',
  },
  {
    key: 'payroll',
    reason: 'No payroll model exists anywhere in this schema.',
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
  ): Promise<RevenueSummary> {
    const { from, to } = resolvePeriod(query);
    // No PaymentStatus filter: Payment.amount is always the original
    // charge regardless of refund status (refunds are tracked
    // separately and never mutate it -- see the Payment model comment),
    // so every payment counts toward gross revenue; refunds are
    // subtracted below to get net.
    const paymentWhere = {
      organizationId,
      createdAt: { gte: from, lte: to },
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
          createdAt: { gte: from, lte: to },
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

    const revenue: RevenueByCurrency[] = grossByCurrency.map((row) => {
      const gross = Number(row._sum.amount ?? 0);
      const membership = membershipRevenueByCurrency.get(row.currency) ?? 0;
      const refunded = refundedByCurrency.get(row.currency) ?? 0;
      return {
        currency: row.currency,
        paymentCount: row._count,
        grossRevenue: gross.toFixed(2),
        membershipRevenue: membership.toFixed(2),
        otherRevenue: (gross - membership).toFixed(2),
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
    const monthStarts = Array.from(
      { length: months },
      (_, i) =>
        new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth() - (months - 1 - i),
            1,
          ),
        ),
    );

    return Promise.all(
      monthStarts.map(async (start) => {
        const end = new Date(
          Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
        );
        const paymentWhere = {
          organizationId,
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

        const revenue: RevenueMonth[] = gross.map((row) => {
          const grossAmount = Number(row._sum.amount ?? 0);
          const refunded = refundedByCurrency.get(row.currency) ?? 0;
          return {
            currency: row.currency,
            grossRevenue: grossAmount.toFixed(2),
            refunded: refunded.toFixed(2),
            netRevenue: (grossAmount - refunded).toFixed(2),
          };
        });

        return { month: start.toISOString().slice(0, 7), revenue };
      }),
    );
  }

  /// Same "outstanding balance" definition PaymentOverdueScanner uses
  /// (membership.price minus net real payments against it), aggregated
  /// into per-currency totals instead of per-membership reminders --
  /// see that scanner's comment for why this isn't an invoice/due-date
  /// system.
  private async getOutstandingBalances(
    organizationId: string,
    branchScope: string | null,
  ): Promise<OutstandingByCurrency[]> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        status: { in: ['ACTIVE', 'PENDING'] },
        startDate: { lte: new Date() },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: {
        price: true,
        currency: true,
        payments: {
          select: { amount: true, refunds: { select: { amount: true } } },
        },
      },
    });

    const byCurrency = new Map<string, { count: number; total: number }>();
    for (const membership of memberships) {
      const grossPaid = membership.payments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );
      const refunded = membership.payments
        .flatMap((p) => p.refunds)
        .reduce((sum, r) => sum + Number(r.amount), 0);
      const outstanding = Number(membership.price) - (grossPaid - refunded);
      if (outstanding <= 0) continue;

      const entry = byCurrency.get(membership.currency) ?? {
        count: 0,
        total: 0,
      };
      entry.count += 1;
      entry.total += outstanding;
      byCurrency.set(membership.currency, entry);
    }

    return Array.from(byCurrency.entries()).map(
      ([currency, { count, total }]) => ({
        currency,
        membershipsWithBalance: count,
        outstandingBalance: total.toFixed(2),
      }),
    );
  }
}

/// Defaults to the current UTC calendar month when the caller doesn't
/// specify a range -- the "this period" a revenue view would open to.
function resolvePeriod(query: { from?: string; to?: string }): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from, to };
}
