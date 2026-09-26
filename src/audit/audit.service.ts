import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { ListAuditLogsDto } from './dto/list-audit-logs.dto';

export interface RecordAuditEntryInput {
  organizationId: string | null;
  branchId?: string | null;
  actorUserId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Writes immutable audit trail entries. Nothing in this module ever
 * updates or deletes an AuditLog row -- callers only ever create new ones.
 *
 * Two ways to produce entries:
 *  - Automatically, for any mutating request on a controller/handler
 *    annotated with @Audited(...) (see AuditInterceptor).
 *  - Explicitly, by injecting AuditService directly for actions that need
 *    a hand-written before/after state (e.g. role changes).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: RecordAuditEntryInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        branchId: entry.branchId ?? null,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        beforeState:
          entry.beforeState === undefined
            ? undefined
            : (entry.beforeState as object),
        afterState:
          entry.afterState === undefined
            ? undefined
            : (entry.afterState as object),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  /**
   * The trail, newest first.
   *
   * Scoped to one organization like every other read. Rows whose
   * organizationId is null are platform-level and deliberately excluded:
   * they belong to no tenant, and a gym must not see another's.
   */
  async list(organizationId: string, query: ListAuditLogsDto) {
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      ...(query.resource ? { resource: query.resource } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const withState = query.withState === 'true';
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        ...skipTake(query),
        // Newest first regardless of `order`: an audit trail is read
        // backwards from now, and there is no reading it forwards from a
        // date nobody remembers.
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          action: true,
          resource: true,
          resourceId: true,
          branchId: true,
          ipAddress: true,
          userAgent: true,
          requestId: true,
          createdAt: true,
          beforeState: withState,
          afterState: withState,
          actorUser: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginate(
      items.map(({ actorUser, ...row }) => ({
        ...row,
        // Flattened, and kept even when the user row is gone: onDelete
        // SetNull nulls the actor rather than removing the entry, because
        // "who did this" losing its answer must not lose the event too.
        actorUserId: actorUser?.id ?? null,
        actorName: actorUser
          ? `${actorUser.firstName} ${actorUser.lastName}`.trim()
          : null,
        actorEmail: actorUser?.email ?? null,
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async facets(organizationId: string) {
    const [resources, actions] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['resource'],
        where: { organizationId },
        _count: { _all: true },
        orderBy: { resource: 'asc' },
      }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where: { organizationId },
        _count: { _all: true },
        orderBy: { action: 'asc' },
      }),
    ]);
    return {
      resources: resources.map((row) => ({
        value: row.resource,
        count: row._count._all,
      })),
      actions: actions.map((row) => ({
        value: row.action,
        count: row._count._all,
      })),
    };
  }
}
