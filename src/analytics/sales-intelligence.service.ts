import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
}
