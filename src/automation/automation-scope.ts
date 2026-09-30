import type { OrganizationStatus, Prisma } from '@prisma/client';

/**
 * The gyms automations run for: trialling or paying. A SUSPENDED or
 * CANCELLED gym's members must not keep receiving reminders in its name
 * -- before this, every scanner swept every organization regardless.
 */
export const RUNNING_ORG_STATUSES: OrganizationStatus[] = ['TRIAL', 'ACTIVE'];

export const runningOrganization: Prisma.OrganizationWhereInput = {
  status: { in: RUNNING_ORG_STATUSES },
  deletedAt: null,
};

/** A date as a person reads it, in the gym's own timezone -- "14 Oct
 * 2026", not the ISO "2026-10-14" the messages used to carry. */
export function readableDate(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: timezone,
    }).format(date);
  } catch {
    // An unknown timezone string must not stop the reminder.
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }
}

/** An amount in its currency, e.g. "₹1,999" or "US$25.50". */
export function readableMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
