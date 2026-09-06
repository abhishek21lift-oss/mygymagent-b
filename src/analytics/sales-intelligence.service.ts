import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface SalesFunnel {
  period: { from: string | null; to: string | null };
  byStatus: { status: string; count: number }[];
  totalLeads: number;
  wonLeads: number;
  conversionRatePct: string;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Sales funnel and source performance, computed from real Lead/
 * LeadFollowUp rows. No marketing data is fabricated when source is absent.
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
    const conversionDays = wonLeads.map(
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
    const rows = await this.prisma.lead.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: { source: true, status: true },
    });

    const grouped = new Map<
      string,
      { totalLeads: number; wonLeads: number; lostLeads: number }
    >();
    for (const row of rows) {
      const source = row.source?.trim() || 'Unknown';
      const current = grouped.get(source) ?? {
        totalLeads: 0,
        wonLeads: 0,
        lostLeads: 0,
      };
      current.totalLeads += 1;
      if (row.status === 'WON') current.wonLeads += 1;
      if (row.status === 'LOST') current.lostLeads += 1;
      grouped.set(source, current);
    }

    return [...grouped.entries()]
      .map(([source, value]) => ({
        source,
        ...value,
        conversionRatePct:
          value.totalLeads > 0
            ? ((value.wonLeads / value.totalLeads) * 100).toFixed(2)
            : '0.00',
      }))
      .sort((a, b) => b.totalLeads - a.totalLeads || b.wonLeads - a.wonLeads);
  }
}
