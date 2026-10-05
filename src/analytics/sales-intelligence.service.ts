import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { organizationTimezone, startOfZonedDay } from '../common/time/zoned';

export type SalesPrioritySeverity = 'hot' | 'warm' | 'watch';

export interface SalesPriorityItem {
  leadId: string;
  firstName: string;
  lastName: string;
  source: string | null;
  status: string;
  severity: SalesPrioritySeverity;
  /// Evidence lines, e.g. "Follow-up overdue by 2 days".
  reasons: string[];
  followUpDueAt: string | null;
  overdueFollowUps: number;
}

export interface SalesPriority {
  items: SalesPriorityItem[];
  counts: { hot: number; warm: number; watch: number };
}

export interface SalesFunnel {
  period: { from: string | null; to: string | null };
  byStatus: { status: string; count: number }[];
  totalLeads: number;
  wonLeads: number;
  /// wonLeads / totalLeads, as a percentage string ("0.00" when
  /// totalLeads is 0 -- never a NaN/Infinity from a divide-by-zero).
  conversionRatePct: string;
  /// Null when there are no WON leads with both createdAt and
  /// convertedAt to compute a gap from, not 0 (0 would misleadingly
  /// read as "everyone converts instantly").
  averageDaysToConversion: number | null;
  followUps: {
    total: number;
    completed: number;
    completionRatePct: string;
  };
}

export interface SalesSourcePerformance {
  source: string;
  totalLeads: number;
  wonLeads: number;
  lostLeads: number;
  conversionRatePct: string;
}

export interface SalesLostReason {
  reason: string;
  lostLeads: number;
}

export interface SalesAssigneePerformance {
  assigneeId: string | null;
  assigneeName: string;
  totalLeads: number;
  wonLeads: number;
  lostLeads: number;
  openLeads: number;
  conversionRatePct: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Lead funnel and follow-up discipline, computed from real `Lead`/
 * `LeadFollowUp` rows -- see `src/crm/` for the state machine this
 * reports on (NEW -> CONTACTED -> QUALIFIED -> TRIAL -> WON/LOST,
 * WON only settable via `/leads/:id/convert`).
 */
@Injectable()
export class SalesIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getFunnel(
    organizationId: string,
    branchScope: string | null,
    query: { from?: string; to?: string },
  ): Promise<SalesFunnel> {
    const dateFilter =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    const leadWhere = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(dateFilter ? { createdAt: dateFilter } : {}),
    };

    const [byStatus, wonLeads, followUps] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['status'],
        where: leadWhere,
        _count: true,
      }),
      this.prisma.lead.findMany({
        where: { ...leadWhere, status: 'WON', convertedAt: { not: null } },
        select: { createdAt: true, convertedAt: true },
      }),
      this.prisma.leadFollowUp.findMany({
        where: {
          organizationId,
          lead: {
            ...(branchScope ? { branchId: branchScope } : {}),
            ...(dateFilter ? { createdAt: dateFilter } : {}),
          },
        },
        select: { completedAt: true },
      }),
    ]);

    const totalLeads = byStatus.reduce((sum, row) => sum + row._count, 0);
    const wonCount = byStatus.find((row) => row.status === 'WON')?._count ?? 0;

    const conversionDays = wonLeads
      .filter((lead) => lead.convertedAt)
      .map(
        (lead) =>
          (lead.convertedAt!.getTime() - lead.createdAt.getTime()) / MS_PER_DAY,
      );
    const averageDaysToConversion =
      conversionDays.length > 0
        ? Math.round(
            (conversionDays.reduce((sum, days) => sum + days, 0) /
              conversionDays.length) *
              10,
          ) / 10
        : null;

    const completedFollowUps = followUps.filter(
      (f) => f.completedAt !== null,
    ).length;

    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count,
      })),
      totalLeads,
      wonLeads: wonCount,
      conversionRatePct:
        totalLeads > 0 ? ((wonCount / totalLeads) * 100).toFixed(2) : '0.00',
      averageDaysToConversion,
      followUps: {
        total: followUps.length,
        completed: completedFollowUps,
        completionRatePct:
          followUps.length > 0
            ? ((completedFollowUps / followUps.length) * 100).toFixed(2)
            : '0.00',
      },
    };
  }

  /**
   * Per-source lead performance (walk-in vs referral vs Instagram ...).
   * Null/blank sources collapse to "Unknown" so the chart never shows a
   * blank slice -- the underlying Lead.source stays untouched.
   */
  async getSourcePerformance(
    organizationId: string,
    branchScope: string | null,
    query: { from?: string; to?: string },
  ): Promise<SalesSourcePerformance[]> {
    const dateFilter =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    const leads = await this.prisma.lead.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: { source: true, status: true },
    });

    const bySource = new Map<
      string,
      { total: number; won: number; lost: number }
    >();
    for (const lead of leads) {
      const source = lead.source?.trim() ? lead.source.trim() : 'Unknown';
      const entry = bySource.get(source) ?? { total: 0, won: 0, lost: 0 };
      entry.total += 1;
      if (lead.status === 'WON') entry.won += 1;
      if (lead.status === 'LOST') entry.lost += 1;
      bySource.set(source, entry);
    }

    return [...bySource.entries()]
      .map(([source, entry]) => ({
        source,
        totalLeads: entry.total,
        wonLeads: entry.won,
        lostLeads: entry.lost,
        conversionRatePct:
          entry.total > 0
            ? ((entry.won / entry.total) * 100).toFixed(2)
            : '0.00',
      }))
      .sort((a, b) => b.totalLeads - a.totalLeads);
  }

  /**
   * Why LOST leads were lost, from Lead.lostReason (set by
   * PATCH /leads/:id/status with a required reason). Leads lost before
   * the lostReason column existed group under "Unspecified".
   */
  async getLostReasons(
    organizationId: string,
    branchScope: string | null,
    query: { from?: string; to?: string },
  ): Promise<SalesLostReason[]> {
    const dateFilter =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    const lost = await this.prisma.lead.findMany({
      where: {
        organizationId,
        status: 'LOST',
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: { lostReason: true },
    });

    const byReason = new Map<string, number>();
    for (const lead of lost) {
      const reason = lead.lostReason?.trim()
        ? lead.lostReason.trim()
        : 'Unspecified';
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }

    return [...byReason.entries()]
      .map(([reason, lostLeads]) => ({ reason, lostLeads }))
      .sort((a, b) => b.lostLeads - a.lostLeads);
  }

  /**
   * Per-salesperson pipeline performance. Unassigned leads group under a
   * null assigneeId / "Unassigned" row so no lead is silently dropped
   * from the report.
   */
  async getAssigneePerformance(
    organizationId: string,
    branchScope: string | null,
    query: { from?: string; to?: string },
  ): Promise<SalesAssigneePerformance[]> {
    const dateFilter =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    const leads = await this.prisma.lead.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: {
        status: true,
        assignedToUserId: true,
        assignedToUser: { select: { firstName: true, lastName: true } },
      },
    });

    const byAssignee = new Map<
      string,
      {
        assigneeId: string | null;
        assigneeName: string;
        total: number;
        won: number;
        lost: number;
      }
    >();
    for (const lead of leads) {
      const key = lead.assignedToUserId ?? '__unassigned__';
      const entry = byAssignee.get(key) ?? {
        assigneeId: lead.assignedToUserId,
        assigneeName: lead.assignedToUser
          ? `${lead.assignedToUser.firstName} ${lead.assignedToUser.lastName}`
          : 'Unassigned',
        total: 0,
        won: 0,
        lost: 0,
      };
      entry.total += 1;
      if (lead.status === 'WON') entry.won += 1;
      if (lead.status === 'LOST') entry.lost += 1;
      byAssignee.set(key, entry);
    }

    return [...byAssignee.values()]
      .map((entry) => ({
        assigneeId: entry.assigneeId,
        assigneeName: entry.assigneeName,
        totalLeads: entry.total,
        wonLeads: entry.won,
        lostLeads: entry.lost,
        openLeads: entry.total - entry.won - entry.lost,
        conversionRatePct:
          entry.total > 0
            ? ((entry.won / entry.total) * 100).toFixed(2)
            : '0.00',
      }))
      .sort((a, b) => b.totalLeads - a.totalLeads);
  }

  /**
   * Sales priority queue: open leads ranked by follow-up discipline and
   * freshness, each with evidence lines instead of a black-box score.
   * Hot = an overdue or due-today follow-up; warm = fresh or qualified
   * but unscheduled; everything else is watch. Capped; counts cover the
   * ranking only, not the whole pipeline (funnel owns totals).
   */
  async getSalesPriority(
    organizationId: string,
    branchScope: string | null,
  ): Promise<SalesPriority> {
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const now = new Date();
    const todayStart = startOfZonedDay(now, timezone);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const leads = await this.prisma.lead.findMany({
      where: {
        organizationId,
        status: { in: ['NEW', 'CONTACTED', 'QUALIFIED', 'TRIAL'] },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        followUps: {
          where: { completedAt: null },
          select: { dueAt: true },
          orderBy: { dueAt: 'asc' },
        },
      },
    });

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const items: SalesPriorityItem[] = leads.map((lead) => {
      const overdue = lead.followUps.filter((f) => f.dueAt < todayStart);
      const dueToday = lead.followUps.filter(
        (f) => f.dueAt >= todayStart && f.dueAt < tomorrowStart,
      );
      const ageDays = Math.floor(
        (now.getTime() - lead.createdAt.getTime()) / MS_PER_DAY,
      );
      const reasons: string[] = [];
      let severity: SalesPrioritySeverity = 'watch';
      if (overdue.length > 0) {
        const oldest = Math.floor(
          (todayStart.getTime() -
            Math.min(...overdue.map((f) => f.dueAt.getTime()))) /
            MS_PER_DAY,
        );
        severity = 'hot';
        reasons.push(
          `Follow-up overdue by ${oldest} day${oldest === 1 ? '' : 's'}`,
        );
      } else if (dueToday.length > 0) {
        severity = 'hot';
        reasons.push('Follow-up due today');
      } else {
        if (ageDays <= 3) {
          severity = 'warm';
          reasons.push('New lead — contact within 24 hours');
        }
        if (
          (lead.status === 'QUALIFIED' || lead.status === 'TRIAL') &&
          lead.followUps.length === 0
        ) {
          severity = 'warm';
          reasons.push(
            `${lead.status === 'QUALIFIED' ? 'Qualified' : 'Trialing'} with no follow-up scheduled`,
          );
        }
        if (reasons.length === 0) {
          reasons.push(
            lead.followUps.length > 0
              ? 'Follow-up scheduled'
              : 'No follow-up scheduled',
          );
        }
      }
      const nextDue = [...overdue, ...dueToday].sort(
        (a, b) => a.dueAt.getTime() - b.dueAt.getTime(),
      )[0];
      return {
        leadId: lead.id,
        firstName: lead.firstName,
        lastName: lead.lastName,
        source: lead.source,
        status: lead.status,
        severity,
        reasons,
        followUpDueAt: nextDue ? nextDue.dueAt.toISOString() : null,
        overdueFollowUps: overdue.length,
      };
    });

    const rank: Record<SalesPrioritySeverity, number> = {
      hot: 0,
      warm: 1,
      watch: 2,
    };
    items.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const top = items.slice(0, 25);
    return {
      items: top,
      counts: {
        hot: items.filter((i) => i.severity === 'hot').length,
        warm: items.filter((i) => i.severity === 'warm').length,
        watch: items.filter((i) => i.severity === 'watch').length,
      },
    };
  }
}
