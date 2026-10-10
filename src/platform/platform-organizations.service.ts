import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import type { ListPlatformOrganizationsQueryDto } from './dto/list-platform-organizations-query.dto';
import type { UpdateOrganizationStatusDto } from './dto/update-organization-status.dto';
import type { SetOrganizationPlanDto } from './dto/set-organization-plan.dto';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Deliberately NOT organizationId-scoped -- this is the one place in the
 * codebase that reads and writes across every tenant. It exists only
 * because every method here is reached exclusively through
 * PlatformOrganizationsController, which is guarded by
 * @RequirePlatformRole() (PlatformRoleGuard), never by the normal
 * organizationId-derived-from-JWT pattern every other service uses. See
 * docs/architecture/adr/0001-multi-tenancy-strategy.md's trade-offs
 * section: cross-tenant queries are easy to write correctly and easy to
 * write incorrectly, so this file, not scattered call sites, is the one
 * place that pattern is allowed to appear.
 */
@Injectable()
export class PlatformOrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: PlatformBillingService,
  ) {}

  async list(query: ListPlatformOrganizationsQueryDto) {
    const where: Prisma.OrganizationWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              {
                name: {
                  contains: query.search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                slug: {
                  contains: query.search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        orderBy: { createdAt: query.order ?? 'desc' },
        ...skipTake(query),
        include: {
          _count: { select: { branches: true, users: true, members: true } },
        },
      }),
      this.prisma.organization.count({ where }),
    ]);

    return paginate(items, total, query.page, query.pageSize);
  }

  async findOne(id: string) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      include: {
        branches: { where: { deletedAt: null } },
        _count: { select: { users: true, members: true } },
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /**
   * The active plan catalog for the operator's plan picker. Same rows as
   * the tenant-facing `platform-billing/plans`, but that route requires a
   * `platform_billing.read` grant -- which platform staff (null org) can
   * never hold -- so the operator console needs its own read path.
   */
  async plans() {
    return this.prisma.$queryRawUnsafe<Array<{ key: string; name: string }>>(
      `SELECT "key", "name" FROM subscription_plans WHERE "isActive"=true ORDER BY "sortOrder" ASC`,
    );
  }

  async updateStatus(
    id: string,
    dto: UpdateOrganizationStatusDto,
    actorUserId: string,
    meta: RequestMeta,
  ) {
    const before = await this.findOne(id);
    const updated = await this.prisma.organization.update({
      where: { id },
      data: { status: dto.status },
    });

    // Recorded explicitly rather than via @Audited(): that interceptor logs
    // the *actor's* organizationId, which is null for platform staff -- it
    // would misfile this under no organization instead of the one actually
    // affected.
    await this.audit.record({
      organizationId: id,
      actorUserId,
      action: 'platform.update_organization_status',
      resource: 'organization',
      resourceId: id,
      beforeState: { status: before.status },
      afterState: { status: updated.status },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return updated;
  }

  async setPlan(
    id: string,
    dto: SetOrganizationPlanDto,
    actorUserId: string,
    meta: RequestMeta,
  ) {
    await this.findOne(id);
    const { before, after } = await this.billing.setPlan(
      id,
      dto.planKey,
      dto.months ?? 1,
    );
    // Explicit for the same reason as updateStatus: filed under the
    // organization whose plan changed, not the platform actor's null org.
    await this.audit.record({
      organizationId: id,
      actorUserId,
      action: 'platform.set_organization_plan',
      resource: 'organization_subscription',
      resourceId: id,
      beforeState: before
        ? {
            planKey: before.planKey,
            currentPeriodEnd: before.currentPeriodEnd,
          }
        : null,
      afterState: {
        planKey: after.planKey,
        currentPeriodEnd: after.currentPeriodEnd,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    return after;
  }
}
