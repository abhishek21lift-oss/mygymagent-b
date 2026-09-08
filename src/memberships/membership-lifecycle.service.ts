import { PaymentStatus, Prisma } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ExtendMembershipDto,
  MembershipPlanChangeDto,
  PauseMembershipDto,
  PaymentFailureDto,
  TransferMembershipDto,
} from './dto/membership-lifecycle.dto';
import { ChangeMembershipPlanDto } from './dto/change-membership-plan.dto';
import { MembershipsService } from './memberships.service';

const DAY = 86_400_000;

/**
 * Thin adapter over MembershipsService. All state-changing mechanics
 * (transactions, status history, member sync, domain events, proration)
 * live in MembershipsService — the single source of truth. This service
 * exists to keep the remote-shipped route/DTO contracts
 * (pause {days,reason}, upgrade/downgrade {membershipPlanId,...},
 * transfer {memberId,...}, flat analytics summary) working unchanged,
 * plus the small read-only helpers (renewal watchlist, payment-failure
 * audit record) that have no counterpart in the core service.
 */
@Injectable()
export class MembershipLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly membershipsService: MembershipsService,
  ) {}

  private async audit(
    organizationId: string,
    branchId: string,
    action: string,
    id: string,
    beforeState: unknown,
    afterState: unknown,
    actorUserId?: string,
  ) {
    return this.prisma.auditLog.create({
      data: {
        organizationId,
        branchId,
        actorUserId: actorUserId ?? null,
        action,
        resource: 'membership',
        resourceId: id,
        beforeState: beforeState as Prisma.InputJsonValue,
        afterState: afterState as Prisma.InputJsonValue,
      },
    });
  }

  activate(
    organizationId: string,
    id: string,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    return this.membershipsService.activate(
      organizationId,
      id,
      branchScope,
      actorUserId ?? null,
    );
  }

  /** Remote contract: pause {days, reason}. Semantics: administrative
   * open-ended PAUSED hold (never consumes the plan freeze quota); the
   * requested duration and reason are recorded in the trail. Unpause
   * computes the actual elapsed days and extends endDate accordingly. */
  pause(
    organizationId: string,
    id: string,
    dto: PauseMembershipDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const detail = [
      'Administrative pause',
      dto?.days ? `requested duration: ${dto.days} day(s)` : null,
      dto?.reason ?? null,
    ]
      .filter(Boolean)
      .join(' — ');
    return this.membershipsService.pause(
      organizationId,
      id,
      branchScope,
      actorUserId ?? null,
      detail,
    );
  }

  unpause(
    organizationId: string,
    id: string,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    return this.membershipsService.unpause(
      organizationId,
      id,
      branchScope,
      actorUserId ?? null,
    );
  }

  resume(
    organizationId: string,
    id: string,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    return this.membershipsService.resume(
      organizationId,
      id,
      branchScope,
      actorUserId ?? null,
    );
  }

  extend(
    organizationId: string,
    id: string,
    dto: ExtendMembershipDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    return this.membershipsService.extend(
      organizationId,
      id,
      { days: dto.days },
      branchScope,
      actorUserId ?? null,
    );
  }

  /** Remote contracts POST /memberships/:id/upgrade and /:id/downgrade,
   * both resolved to the canonical prorated plan change. Returns the new
   * membership row (remote contract). */
  async changePlan(
    organizationId: string,
    id: string,
    dto: MembershipPlanChangeDto,
    branchScope: string | null,
    actorUserId?: string,
    direction?: 'UPGRADE' | 'DOWNGRADE',
  ) {
    const result = await this.changePlanDetailed(
      organizationId,
      id,
      dto,
      branchScope,
      actorUserId,
      direction,
    );
    return result.newMembership;
  }

  /** Richer contract for POST /memberships/:id/change-plan, returning
   * the proration breakdown alongside the new membership row. */
  async changePlanDetailed(
    organizationId: string,
    id: string,
    dto: MembershipPlanChangeDto,
    branchScope: string | null,
    actorUserId?: string,
    direction?: 'UPGRADE' | 'DOWNGRADE',
  ) {
    let dir = direction;
    if (!dir) {
      // Direction is derived server-side from the plan prices, matching
      // the audit convention of the shipped implementation.
      const [current, target] = await Promise.all([
        this.prisma.membership.findFirst({
          where: { id, organizationId },
          select: { membershipPlanId: true, price: true },
        }),
        this.prisma.membershipPlan.findFirst({
          where: { id: dto.membershipPlanId, organizationId, isActive: true },
          select: { price: true },
        }),
      ]);
      if (!current) throw new NotFoundException('Membership not found');
      if (!target)
        throw new NotFoundException(
          'Target membership plan not found or inactive',
        );
      dir = target.price.gte(current.price) ? 'UPGRADE' : 'DOWNGRADE';
    }
    const mapped: ChangeMembershipPlanDto = {
      newMembershipPlanId: dto.membershipPlanId,
      direction: dir,
      discount: dto.discount,
      initialPayment: dto.initialPayment,
      paymentMethod: dto.paymentMethod,
    };
    return this.membershipsService.changePlan(
      organizationId,
      id,
      mapped,
      branchScope,
      actorUserId ?? null,
    );
  }

  /** Remote contract: transfer {memberId, reason}. Delegates to the
   * canonical transfer, which chains a new membership row for the
   * recipient and closes the original as CANCELLED. Payments stay
   * attached to the original row — settlement is an explicit
   * refund-and-rerecord, never a silent balance move. */
  transfer(
    organizationId: string,
    id: string,
    dto: TransferMembershipDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    return this.membershipsService.transfer(
      organizationId,
      id,
      { toMemberId: dto.memberId, reason: dto.reason },
      branchScope,
      actorUserId ?? null,
    );
  }

  /** Remote contract: expire due memberships, optionally within one
   * branch. Delegates to the canonical expiry, which records the status
   * trail, syncs member rollup status, and emits MembershipExpired. */
  async expireDue(
    organizationId: string,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    if (!branchScope) {
      const expired =
        await this.membershipsService.expireAllDue(organizationId);
      return { expired };
    }
    const due = await this.prisma.membership.findMany({
      where: {
        organizationId,
        branchId: branchScope,
        status: 'ACTIVE',
        endDate: { lt: new Date() },
      },
      select: { id: true },
    });
    let expired = 0;
    for (const row of due) {
      const result = await this.membershipsService.expire(
        organizationId,
        row.id,
        actorUserId ?? null,
      );
      if (result) expired++;
    }
    return { expired };
  }

  async recordPaymentFailure(
    organizationId: string,
    id: string,
    dto: PaymentFailureDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const row = await this.prisma.membership.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
    });
    if (!row) throw new NotFoundException('Membership not found');
    const failure = {
      amount: dto.amount ?? null,
      reason: dto.reason ?? null,
      attemptedAt: dto.attemptedAt ?? new Date().toISOString(),
    };
    await this.audit(
      organizationId,
      row.branchId,
      'membership.payment_failed',
      id,
      null,
      failure,
      actorUserId,
    );
    this.events.emit('membership.payment_failed', {
      organizationId,
      membershipId: id,
      memberId: row.memberId,
      ...failure,
    });
    return { recorded: true, membershipId: id, ...failure };
  }

  renewalReminders(
    organizationId: string,
    branchScope: string | null,
    days = 7,
  ) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + days * DAY);
    return this.prisma.membership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        endDate: { gt: now, lte: cutoff },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      orderBy: { endDate: 'asc' },
      include: {
        membershipPlan: true,
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });
  }

  /** Flat summary consumed by the shipped MembershipLifecyclePage. */
  async analytics(organizationId: string, branchScope: string | null) {
    const where = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [counts, financial, expiring, nonCompletedPayments] =
      await Promise.all([
        this.prisma.membership.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.membership.aggregate({
          where,
          _sum: { price: true },
          _count: { _all: true },
        }),
        this.prisma.membership.count({
          where: {
            ...where,
            status: 'ACTIVE',
            endDate: { gt: new Date(), lte: new Date(Date.now() + 30 * DAY) },
          },
        }),
        this.prisma.payment.count({
          where: {
            organizationId,
            status: { not: PaymentStatus.COMPLETED },
            ...(branchScope ? { branchId: branchScope } : {}),
          },
        }),
      ]);
    const statusCounts = Object.fromEntries(
      counts.map((r) => [r.status, r._count._all]),
    );
    return {
      total: financial._count._all,
      totalContractValue: financial._sum.price ?? new Prisma.Decimal(0),
      active: statusCounts.ACTIVE ?? 0,
      frozen: statusCounts.FROZEN ?? 0,
      expired: statusCounts.EXPIRED ?? 0,
      cancelled: statusCounts.CANCELLED ?? 0,
      pending: statusCounts.PENDING ?? 0,
      expiringNext30Days: expiring,
      nonCompletedPayments,
    };
  }
}
