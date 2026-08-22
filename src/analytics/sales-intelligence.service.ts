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
}
