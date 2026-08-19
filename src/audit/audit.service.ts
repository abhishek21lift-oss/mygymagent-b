import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
}
