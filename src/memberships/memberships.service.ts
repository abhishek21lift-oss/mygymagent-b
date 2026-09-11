import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import {
  DomainEvent,
  type MembershipCancelledEvent,
  type MembershipStartedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CancelMembershipDto } from './dto/cancel-membership.dto';
import type { CreateMembershipDto } from './dto/create-membership.dto';
import type { FreezeMembershipDto } from './dto/freeze-membership.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const where = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(assignmentScope
        ? { member: { assignedTrainerId: assignmentScope } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          membershipPlan: true,
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.membership.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(assignmentScope
          ? { member: { assignedTrainerId: assignmentScope } }
          : {}),
      },
      include: { membershipPlan: true, member: true },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    return membership;
  }

  async create(
    organizationId: string,
    dto: CreateMembershipDto,
    branchScope: string | null = null,
  ) {
    const [member, plan] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: dto.memberId, organizationId, deletedAt: null },
      }),
      this.prisma.membershipPlan.findFirst({
        where: { id: dto.membershipPlanId, organizationId, isActive: true },
      }),
    ]);
    if (!member) throw new NotFoundException('Member not found');
    if (!plan)
      throw new NotFoundException('Membership plan not found or inactive');
    const branchId = plan.branchId ?? member.primaryBranchId;
    if (branchScope && branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot create a membership for a member outside your assigned branch',
      );
    }
    const startDate = dto.startDate ? new Date(dto.startDate) : new Date();
    const endDate = new Date(
      startDate.getTime() + plan.durationDays * MS_PER_DAY,
    );
    const discount = dto.discount ? new Prisma.Decimal(dto.discount) : null;
    const finalPrice = discount ? plan.price.sub(discount) : plan.price;
    const initialPayment = dto.initialPayment
      ? new Prisma.Decimal(dto.initialPayment)
      : null;

    const membership = await this.prisma.$transaction(async (tx) => {
      const newMembership = await tx.membership.create({
        data: {
          organizationId,
          branchId,
          memberId: member.id,
          membershipPlanId: plan.id,
          status: 'ACTIVE',
          startDate,
          endDate,
          price: finalPrice,
          discount,
          currency: plan.currency,
          autoRenew: dto.autoRenew ?? false,
        },
      });

      if (initialPayment && initialPayment.gt(0)) {
        await tx.payment.create({
          data: {
            organizationId,
            memberId: member.id,
            membershipId: newMembership.id,
            amount: initialPayment,
            currency: plan.currency,
            method: dto.paymentMethod ?? 'CASH',
            status: PaymentStatus.COMPLETED,
          },
        });
      }

      return newMembership;
    });

    const payload: MembershipStartedEvent = {
      organizationId,
      branchId: membership.branchId,
      membershipId: membership.id,
      memberId: membership.memberId,
      membershipPlanId: membership.membershipPlanId,
    };
    this.events.emit(DomainEvent.MembershipStarted, payload);
    return membership;
  }

  async freeze(
    organizationId: string,
    id: string,
    dto: FreezeMembershipDto,
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status !== 'ACTIVE')
      throw new BadRequestException('Only an active membership can be frozen');
    const remainingFreezeDays =
      membership.membershipPlan.maxFreezeDays - membership.totalFreezeDaysUsed;
    if (dto.days > remainingFreezeDays) {
      throw new BadRequestException(
        `Requested freeze of ${dto.days} days exceeds the ${remainingFreezeDays} remaining freeze days on this plan`,
      );
    }
    const freezeStartDate = new Date();
    const freezeEndDate = new Date(
      freezeStartDate.getTime() + dto.days * MS_PER_DAY,
    );
    return this.prisma.membership.update({
      where: { id },
      data: { status: 'FROZEN', freezeStartDate, freezeEndDate },
    });
  }

  async resume(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status !== 'FROZEN' || !membership.freezeStartDate)
      throw new BadRequestException('Membership is not currently frozen');
    const frozenDays = Math.ceil(
      (Date.now() - membership.freezeStartDate.getTime()) / MS_PER_DAY,
    );
    const extendedEndDate = new Date(
      membership.endDate.getTime() + frozenDays * MS_PER_DAY,
    );
    return this.prisma.membership.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        endDate: extendedEndDate,
        freezeStartDate: null,
        freezeEndDate: null,
        totalFreezeDaysUsed: membership.totalFreezeDaysUsed + frozenDays,
      },
    });
  }

  async cancel(
    organizationId: string,
    id: string,
    dto: CancelMembershipDto,
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status === 'CANCELLED')
      throw new BadRequestException('Membership is already cancelled');
    const cancelled = await this.prisma.membership.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: dto.reason,
      },
    });
    const payload: MembershipCancelledEvent = {
      organizationId,
      membershipId: cancelled.id,
      memberId: cancelled.memberId,
    };
    this.events.emit(DomainEvent.MembershipCancelled, payload);
    return cancelled;
  }

  async getOutstandingBalance(organizationId: string, memberId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId, memberId },
      select: { price: true },
    });
    const payments = await this.prisma.payment.findMany({
      where: { organizationId, memberId, status: 'COMPLETED' },
      select: { amount: true },
    });
    const totalDue = memberships.reduce(
      (sum, m) => sum.plus(m.price),
      new Prisma.Decimal(0),
    );
    const totalPaid = payments.reduce(
      (sum, p) => sum.plus(p.amount),
      new Prisma.Decimal(0),
    );
    const outstandingBalance = totalDue.sub(totalPaid);
    return {
      totalDue,
      totalPaid,
      outstandingBalance,
    };
  }

  async renew(
    organizationId: string,
    membershipId: string,
    dto: { discount?: number } = {},
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(
      organizationId,
      membershipId,
      branchScope,
    );
    const isExpiredOrCancelled =
      membership.status === 'EXPIRED' || membership.status === 'CANCELLED';
    if (membership.status === 'FROZEN') {
      throw new BadRequestException(
        'Cannot renew a frozen membership. Please resume it first.',
      );
    }
    const plan = membership.membershipPlan;
    if (isExpiredOrCancelled) {
      const discount = dto.discount ? new Prisma.Decimal(dto.discount) : null;
      const finalPrice = discount ? plan.price.sub(discount) : plan.price;
      const newMembership = await this.prisma.membership.create({
        data: {
          organizationId,
          branchId: membership.branchId,
          memberId: membership.memberId,
          membershipPlanId: plan.id,
          status: 'ACTIVE',
          startDate: new Date(),
          endDate: new Date(Date.now() + plan.durationDays * MS_PER_DAY),
          price: finalPrice,
          discount,
          currency: plan.currency,
          autoRenew: membership.autoRenew,
          previousMembershipId: membership.id,
        },
      });
      return newMembership;
    }
    const extendedEndDate = new Date(
      membership.endDate.getTime() + plan.durationDays * MS_PER_DAY,
    );
    return this.prisma.membership.update({
      where: { id: membershipId },
      data: { endDate: extendedEndDate },
    });
  }

  /**
   * Headline counts for the membership lifecycle screen. All from real
   * Membership rows -- see MembershipLifecycleService for the deeper
   * funnel (rates, tenure, per-currency outstanding).
   */
  async getAnalyticsSummary(
    organizationId: string,
    branchScope: string | null = null,
  ): Promise<Record<string, number | string>> {
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * MS_PER_DAY);
    const [total, active, pending, frozen, expired, cancelled, expiringSoon] =
      await Promise.all([
        this.prisma.membership.count({ where: scoped }),
        this.prisma.membership.count({
          where: { ...scoped, status: 'ACTIVE' },
        }),
        this.prisma.membership.count({
          where: { ...scoped, status: 'PENDING' },
        }),
        this.prisma.membership.count({
          where: { ...scoped, status: 'FROZEN' },
        }),
        this.prisma.membership.count({
          where: { ...scoped, status: 'EXPIRED' },
        }),
        this.prisma.membership.count({
          where: { ...scoped, status: 'CANCELLED' },
        }),
        this.prisma.membership.count({
          where: {
            ...scoped,
            status: 'ACTIVE',
            endDate: { gte: now, lte: in7Days },
          },
        }),
      ]);
    return {
      total,
      active,
      pending,
      frozen,
      expired,
      cancelled,
      expiringSoon,
    };
  }

  /**
   * ACTIVE memberships ending within `days` (default 7), soonest first --
   * the renewal-reminder worklist. Capped at 200 rows; callers needing
   * the full set paginate GET /memberships with status/endDate filters.
   */
  async getRenewalReminders(
    organizationId: string,
    days = 7,
    branchScope: string | null = null,
  ) {
    const now = new Date();
    const horizon = new Date(now.getTime() + days * MS_PER_DAY);
    return this.prisma.membership.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        status: 'ACTIVE',
        endDate: { gte: now, lte: horizon },
      },
      orderBy: { endDate: 'asc' },
      take: 200,
      include: {
        membershipPlan: true,
        member: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  /**
   * Lifecycle trail for one membership, rebuilt from the audit log the
   * @Audited() lifecycle routes write. fromStatus is null -- the
   * decorator captures afterState, not a before/after pair -- so callers
   * should read this as "what happened, when, by whom", not as a
   * field-level diff.
   */
  async getHistory(
    organizationId: string,
    membershipId: string,
    branchScope: string | null = null,
  ) {
    await this.getOne(organizationId, membershipId, branchScope);
    const entries = await this.prisma.auditLog.findMany({
      where: {
        organizationId,
        resource: 'membership',
        resourceId: membershipId,
      },
      orderBy: { createdAt: 'asc' },
      include: {
        actorUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const toStatusFor = (action: string): string | null => {
      const map: Record<string, string> = {
        create: 'ACTIVE',
        activate: 'ACTIVE',
        freeze: 'FROZEN',
        pause: 'FROZEN',
        resume: 'ACTIVE',
        unpause: 'ACTIVE',
        cancel: 'CANCELLED',
        renew: 'ACTIVE',
        extend: 'ACTIVE',
        upgrade: 'ACTIVE',
        downgrade: 'ACTIVE',
        'change-plan': 'ACTIVE',
        transfer: 'ACTIVE',
      };
      return map[action] ?? null;
    };
    return entries.map((entry) => ({
      id: entry.id,
      membershipId,
      fromStatus: null,
      toStatus: toStatusFor(entry.action),
      detail: entry.action,
      changedByUser: entry.actorUser,
      createdAt: entry.createdAt,
    }));
  }

  /** PENDING -> ACTIVE (e.g. after an offline payment clears). */
  async activate(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status !== 'PENDING')
      throw new BadRequestException(
        'Only a pending membership can be activated',
      );
    return this.prisma.membership.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
  }

  /**
   * Pause is the frontend's name for a freeze without a plan-day budget
   * check bypass -- same FROZEN status, same day accounting as freeze().
   * Kept as a separate route only because the membership lifecycle UI
   * posts to /pause and /freeze from different affordances.
   */
  async pause(
    organizationId: string,
    id: string,
    dto: { days?: number; reason?: string },
    branchScope: string | null = null,
  ) {
    return this.freeze(
      organizationId,
      id,
      { days: dto.days ?? 7 },
      branchScope,
    );
  }

  /** Unpause is resume() under the lifecycle UI's route name. */
  async unpause(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    return this.resume(organizationId, id, branchScope);
  }

  /** Push endDate out by `days` without changing the plan. */
  async extend(
    organizationId: string,
    id: string,
    dto: { days: number },
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status === 'CANCELLED' || membership.status === 'EXPIRED')
      throw new BadRequestException(
        'Cannot extend a closed membership. Renew it instead.',
      );
    return this.prisma.membership.update({
      where: { id },
      data: {
        endDate: new Date(membership.endDate.getTime() + dto.days * MS_PER_DAY),
      },
    });
  }

  /**
   * Move a membership to a different plan mid-term. Writes a new chained
   * row (previousMembershipId) like renew() so price history never
   * rewrites itself; `credit` is the pro-rata remaining value of the old
   * row applied against the new plan price, `amountDue` what is still
   * owed after credit (never negative -- over-credit is truncated, not
   * paid out).
   */
  async changePlan(
    organizationId: string,
    id: string,
    dto: {
      membershipPlanId: string;
      discount?: number;
      initialPayment?: number;
      paymentMethod?: string;
    },
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status === 'CANCELLED' || membership.status === 'EXPIRED')
      throw new BadRequestException(
        'Cannot change the plan of a closed membership. Renew it instead.',
      );
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: dto.membershipPlanId, organizationId, isActive: true },
    });
    if (!plan)
      throw new NotFoundException('Membership plan not found or inactive');

    const now = Date.now();
    const totalMs =
      membership.endDate.getTime() - membership.startDate.getTime();
    const remainingMs = Math.max(0, membership.endDate.getTime() - now);
    const credit =
      totalMs > 0
        ? membership.price.mul(remainingMs).div(totalMs)
        : new Prisma.Decimal(0);
    const discount = dto.discount
      ? new Prisma.Decimal(dto.discount)
      : new Prisma.Decimal(0);
    const amountDue = Prisma.Decimal.max(
      plan.price.sub(credit).sub(discount),
      new Prisma.Decimal(0),
    );

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: `Changed to plan ${plan.name}`,
        },
      });
      const newMembership = await tx.membership.create({
        data: {
          organizationId,
          branchId: membership.branchId,
          memberId: membership.memberId,
          membershipPlanId: plan.id,
          status: 'ACTIVE',
          startDate: new Date(),
          endDate: new Date(now + plan.durationDays * MS_PER_DAY),
          price: plan.price.sub(discount),
          discount: discount.gt(0) ? discount : null,
          currency: plan.currency,
          autoRenew: membership.autoRenew,
          previousMembershipId: membership.id,
        },
      });
      if (dto.initialPayment && dto.initialPayment > 0) {
        await tx.payment.create({
          data: {
            organizationId,
            memberId: membership.memberId,
            membershipId: newMembership.id,
            amount: new Prisma.Decimal(dto.initialPayment),
            currency: plan.currency,
            method: (dto.paymentMethod as PaymentMethod) ?? PaymentMethod.CASH,
            status: PaymentStatus.COMPLETED,
          },
        });
      }
      return newMembership;
    });

    return {
      newMembership: result,
      credit: credit.toFixed(2),
      amountDue: amountDue.toFixed(2),
    };
  }

  /**
   * Move a membership to a different member (e.g. a transferable plan
   * gifted to family). Both members must belong to this organization.
   */
  async transfer(
    organizationId: string,
    id: string,
    dto: { memberId: string; reason?: string },
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    const target = await this.prisma.member.findFirst({
      where: { id: dto.memberId, organizationId, deletedAt: null },
    });
    if (!target) throw new NotFoundException('Target member not found');
    if (target.id === membership.memberId)
      throw new BadRequestException('Membership is already with this member');
    return this.prisma.membership.update({
      where: { id },
      data: {
        memberId: target.id,
        cancellationReason: dto.reason
          ? `Transferred: ${dto.reason}`
          : membership.cancellationReason,
      },
    });
  }

  /**
   * Record a failed collection attempt against a membership as a FAILED
   * payment row (immutable ledger -- a failure is a fact about an
   * attempt, never a mutation of a prior COMPLETED row).
   */
  async recordPaymentFailure(
    organizationId: string,
    id: string,
    dto: { amount?: number; reason?: string },
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    return this.prisma.payment.create({
      data: {
        organizationId,
        branchId: membership.branchId,
        memberId: membership.memberId,
        membershipId: membership.id,
        amount: new Prisma.Decimal(dto.amount ?? 0),
        currency: membership.currency,
        method: PaymentMethod.OTHER,
        status: PaymentStatus.FAILED,
        note: dto.reason ?? 'Payment failed',
      },
    });
  }
}
