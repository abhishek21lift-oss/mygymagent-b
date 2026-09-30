import { Prisma } from '@prisma/client';

/** Payment statuses that brought money in. A REFUNDED payment still did;
 * its refunds are counted separately. FAILED never did. */
export const COLLECTED_PAYMENT_STATUSES = [
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

export interface BalanceMembership {
  id: string;
  /** What the member owes for the term: already net of any discount. */
  price: Prisma.Decimal;
  status: string;
}

export interface BalancePayment {
  membershipId: string | null;
  amount: Prisma.Decimal;
  status: string;
  refunds: { amount: Prisma.Decimal }[];
}

export interface MembershipBalance {
  due: Prisma.Decimal;
  paid: Prisma.Decimal;
  refunded: Prisma.Decimal;
  outstanding: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

/**
 * The one definition of what a member owes on their memberships -- the
 * member page, Member 360 and the balance endpoint each had their own,
 * and they disagreed:
 *
 * - `price` is already net of the discount. Two of them subtracted the
 *   discount again, so every discounted member looked like they owed
 *   less than they did.
 * - Paid is money that came in: COMPLETED, PARTIALLY_REFUNDED and
 *   REFUNDED payments, with their refunds counted as refunded. FAILED
 *   attempts never count. (One version dropped partly refunded payments
 *   whole; another counted every payment it could see.)
 * - A cancelled membership is owed only up to what was paid on it:
 *   cancelling waives the unpaid rest. Otherwise an unpaid, cancelled
 *   term stayed on the member's balance for ever.
 *
 * Only payments against one of the given memberships count; a drop-in
 * payment with no membership is not a membership payment.
 */
export function membershipBalances(
  memberships: BalanceMembership[],
  payments: BalancePayment[],
): { byMembership: Map<string, MembershipBalance>; total: MembershipBalance } {
  const byMembership = new Map<string, MembershipBalance>();
  for (const membership of memberships) {
    byMembership.set(membership.id, {
      due: ZERO,
      paid: ZERO,
      refunded: ZERO,
      outstanding: ZERO,
    });
  }
  for (const payment of payments) {
    if (!payment.membershipId) continue;
    if (
      !(COLLECTED_PAYMENT_STATUSES as readonly string[]).includes(
        payment.status,
      )
    ) {
      continue;
    }
    const entry = byMembership.get(payment.membershipId);
    if (!entry) continue;
    entry.paid = entry.paid.plus(payment.amount);
    entry.refunded = payment.refunds.reduce(
      (sum, refund) => sum.plus(refund.amount),
      entry.refunded,
    );
  }

  const total: MembershipBalance = {
    due: ZERO,
    paid: ZERO,
    refunded: ZERO,
    outstanding: ZERO,
  };
  for (const membership of memberships) {
    const entry = byMembership.get(membership.id)!;
    const kept = Prisma.Decimal.max(entry.paid.minus(entry.refunded), ZERO);
    entry.due =
      membership.status === 'CANCELLED'
        ? Prisma.Decimal.min(membership.price, kept)
        : new Prisma.Decimal(membership.price);
    entry.outstanding = entry.due.minus(entry.paid).plus(entry.refunded);
    total.due = total.due.plus(entry.due);
    total.paid = total.paid.plus(entry.paid);
    total.refunded = total.refunded.plus(entry.refunded);
  }
  total.outstanding = total.due.minus(total.paid).plus(total.refunded);
  return { byMembership, total };
}
