import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Collector, CollectorResult } from '../collectors.types';

export interface TenantsCard {
  /** Live organizations (soft-deleted ones excluded). */
  total: number;
  trial: number;
  active: number;
  suspended: number;
  cancelled: number;
  /** Organizations created in the last 7 days. */
  newLast7Days: number;
}

/**
 * The platform's tenant base at a glance. Read-only counts; managing an
 * organization stays on /platform/organizations.
 */
@Injectable()
export class TenantsCollector implements Collector<TenantsCard> {
  readonly name = 'tenants';
  readonly timeoutMs = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<CollectorResult<TenantsCard>> {
    const live = { deletedAt: null };
    const [byStatus, newLast7Days] = await Promise.all([
      this.prisma.organization.groupBy({
        by: ['status'],
        where: live,
        _count: { _all: true },
      }),
      this.prisma.organization.count({
        where: {
          ...live,
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) },
        },
      }),
    ]);
    const of = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      status: 'ok',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: {
        total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        trial: of('TRIAL'),
        active: of('ACTIVE'),
        suspended: of('SUSPENDED'),
        cancelled: of('CANCELLED'),
        newLast7Days,
      },
    };
  }
}
