import { Injectable } from '@nestjs/common';
import {
  organizationTimezone,
  zonedBound,
  zonedDate,
} from '../common/time/zoned';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceService, type OutstandingScopeCache } from './finance.service';
import { currentTermWhere } from './member-intelligence.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const EXPIRING_WINDOW_DAYS = 7;

/** One gym day's figures, the same ones the dashboard's Today tiles show. */
export interface DayFigures {
  /** YYYY-MM-DD, the gym's local day. */
  date: string;
  timezone: string;
  /** Members admitted at the door; staff check-ins and denials excluded. */
  checkIns: number;
  deniedCheckIns: number;
  /** The organization's currency, which the money figures below are in. */
  currency: string;
  /** Every currency payments came in that day (normally just one). */
  currencies: string[];
  /** Gross takings: payments plus product sales, failed payments excluded. */
  collected: number;
  /** Collected minus that day's refunds. */
  net: number;
  paymentCount: number;
  newMembers: number;
  /** Memberships sold that day that continue an earlier one. */
  renewals: number;
  leads: number;
}

function ymd(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * The one definition of "today's numbers".
 *
 * The dashboard tiles, the daily briefing, the COO page and the AI agent
 * each used to count today their own way: one took the UTC date, one
 * counted staff check-ins, one left product sales out of revenue, and
 * they scoped a branch by three different columns. Each figure here uses
 * exactly the rule of the endpoint behind the matching dashboard tile:
 *
 * - check-ins: member visits admitted at the door, by `attendance.branchId`
 *   (`/briefing/daily`);
 * - money: FinanceService over the gym's day, by `payment.branchId`
 *   (`/analytics/revenue`);
 * - new members: `joinedAt` in the gym's day, by `primaryBranchId`
 *   (`/members?joinedFrom&joinedTo`);
 * - renewals: memberships created that day with a previous term, by the
 *   membership's `branchId` (`/memberships?createdFrom&createdTo`);
 * - leads: leads created that day, by `branchId` (`/leads`).
 */
@Injectable()
export class TodayFiguresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
  ) {}

  /** The gym's local date `daysAgo` days before now. */
  async gymDay(organizationId: string, daysAgo = 0): Promise<string> {
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const today = zonedDate(new Date(), timezone);
    // Noon UTC on today's date, stepped back whole days, lands on the
    // right calendar date whatever the offset.
    const noon = Date.UTC(today.year, today.month - 1, today.day, 12);
    return new Date(noon - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
  }

  async forDay(
    organizationId: string,
    branchScope: string | null,
    day?: string,
    outstandingCache?: OutstandingScopeCache,
  ): Promise<DayFigures> {
    const [timezone, org] = await Promise.all([
      organizationTimezone(this.prisma, organizationId),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      }),
    ]);
    const date = day ?? ymd(zonedDate(new Date(), timezone));
    const from = zonedBound(date, timezone, 'from');
    const to = zonedBound(date, timezone, 'to');
    const inDay = { gte: from, lt: to };
    const memberVisit = {
      organizationId,
      memberId: { not: null },
      checkInAt: inDay,
      ...(branchScope ? { branchId: branchScope } : {}),
    };

    const [checkIns, deniedCheckIns, revenue, newMembers, renewals, leads] =
      await Promise.all([
        this.prisma.attendance.count({
          where: { ...memberVisit, deniedReason: null },
        }),
        this.prisma.attendance.count({
          where: { ...memberVisit, deniedReason: { not: null } },
        }),
        this.finance.getRevenueSummary(
          organizationId,
          { from: date, to: date },
          branchScope,
          outstandingCache,
        ),
        this.prisma.member.count({
          where: {
            organizationId,
            deletedAt: null,
            joinedAt: inDay,
            ...(branchScope ? { primaryBranchId: branchScope } : {}),
          },
        }),
        this.prisma.membership.count({
          where: {
            organizationId,
            createdAt: inDay,
            previousMembershipId: { not: null },
            ...(branchScope ? { branchId: branchScope } : {}),
          },
        }),
        this.prisma.lead.count({
          where: {
            organizationId,
            createdAt: inDay,
            ...(branchScope ? { branchId: branchScope } : {}),
          },
        }),
      ]);

    const currencies = revenue.revenue.map((r) => r.currency);
    const currency = org?.currency ?? currencies[0] ?? 'INR';
    const row =
      revenue.revenue.find((r) => r.currency === currency) ??
      revenue.revenue[0];
    return {
      date,
      timezone,
      checkIns,
      deniedCheckIns,
      currency: row?.currency ?? currency,
      currencies,
      collected: row ? Number(row.grossRevenue) : 0,
      net: row ? Number(row.netRevenue) : 0,
      paymentCount: row?.paymentCount ?? 0,
      newMembers,
      renewals,
      leads,
    };
  }

  /**
   * Running memberships ending within the week that nobody has renewed
   * yet, by the member's primary branch: the dashboard's "expiring soon".
   */
  expiringSoon(
    organizationId: string,
    branchScope: string | null,
    now = new Date(),
  ): Promise<number> {
    return this.prisma.membership.count({
      where: {
        organizationId,
        ...currentTermWhere(now),
        endDate: {
          gte: now,
          lte: new Date(now.getTime() + EXPIRING_WINDOW_DAYS * MS_PER_DAY),
        },
        OR: [
          { nextMembership: { is: null } },
          { nextMembership: { is: { status: 'CANCELLED' } } },
        ],
        member: {
          deletedAt: null,
          ...(branchScope ? { primaryBranchId: branchScope } : {}),
        },
      },
    });
  }
}
