import { PaymentStatus, Prisma } from '@prisma/client';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { DomainEvent } from '../events/domain-events';
import type {
  ExtendMembershipDto,
  MembershipPlanChangeDto,
  PauseMembershipDto,
  PaymentFailureDto,
  TransferMembershipDto,
} from './dto/membership-lifecycle.dto';

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class MembershipLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private async getMembership(
    organizationId: string,
    id: string,
    branchScope: string | null,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: { membershipPlan: true, member: true },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    return membership;
  }

  private async audit(
    organizationId: string,
    branchId: string | null,
    action: string,
    resourceId: string,
    beforeState: unknown,
    afterState: unknown,
    actorUserId?: string,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        branchId,
        actorUserId: actorUserId ?? null,
        action,
        resource: 'membership',
        resourceId,
        beforeState: beforeState as Prisma.InputJsonValue,
        afterState: afterState as Prisma.InputJsonValue,
      },
    });
  }

  async activate(
    organizationId: string,
    id: string,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const membership = await this.getMembership(organizationId, id, branchScope);
    if (membership.status !== 'PENDING') {
      if (membership.status === 'ACTIVE') return membership;
      throw new BadRequestException(`Cannot activate membership in ${membership.status} state`);
    }
    const updated = await this.prisma.membership.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
    await this.audit(organizationId, updated.branchId, 'membership.activated', id, { status: membership.status }, { status: updated.status }, actorUserId);
    this.events.emit(DomainEvent.MembershipStarted, {
      organizationId,
      branchId: updated.branchId,
      membershipId: updated.id,
      memberId: updated.memberId,
      membershipPlanId: updated.membershipPlanId,
    });
    return updated;
  }

  async pause(
    organizationId: string,
    id: string,
    dto: PauseMembershipDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const membership = await this.getMembership(organizationId, id, branchScope);
    if (membership.status !== 'ACTIVE') throw new BadRequestException('Only an active membership can be paused');
    const remaining = membership.membershipPlan.maxFreezeDays - membership.totalFreezeDaysUsed;
    if (dto.days > remaining) throw new BadRequestException(`Requested pause exceeds ${remaining} remaining freeze days`);
    const start = new Date();
    const end = new Date(start.getTime() + dto.days * DAY);
    const updated = await this.prisma.membership.update({
      where: { id },
      data: { status: 'FROZEN', freezeStartDate: start, freezeEndDate: end },
    });
    await this.audit(organizationId, updated.branchId, 'membership.paused', id, { status: membership.status }, { status: updated.status, pauseDays: dto.days, reason: dto.reason ?? null }, actorUserId);
    return updated;
  }

  async resume(
    organizationId: string,
    id: string,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const membership = await this.getMembership(organizationId, id, branchScope);
    if (membership.status !== 'FROZEN' || !membership.freezeStartDate) throw new BadRequestException('Membership is not paused/frozen');
    const effectiveEnd = membership.freezeEndDate && membership.freezeEndDate.getTime() < Date.now() ? membership.freezeEndDate : new Date();
    const frozenDays = Math.max(0, Math.ceil((effectiveEnd.getTime() - membership.freezeStartDate.getTime()) / DAY));
    const updated = await this.prisma.membership.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        endDate: new Date(membership.endDate.getTime() + frozenDays * DAY),
        freezeStartDate: null,
        freezeEndDate: null,
        totalFreezeDaysUsed: membership.totalFreezeDaysUsed + frozenDays,
      },
    });
    await this.audit(organizationId, updated.branchId, 'membership.resumed', id, { status: membership.status }, { status: updated.status, frozenDays }, actorUserId);
    return updated;
  }

  async extend(
    organizationId: string,
    id: string,
    dto: ExtendMembershipDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const membership = await this.getMembership(organizationId, id, branchScope);
    if (membership.status === 'CANCELLED') throw new BadRequestException('Cancelled membership cannot be extended');
    const updated = await this.prisma.membership.update({
      where: { id },
      data: { endDate: new Date(membership.endDate.getTime() + dto.days * DAY) },
    });
    await this.audit(organizationId, updated.branchId, 'membership.extended', id, { endDate: membership.endDate.toISOString() }, { endDate: updated.endDate.toISOString(), days: dto.days }, actorUserId);
    return updated;
  }

  async changePlan(
    organizationId: string,
    id: string,
    dto: MembershipPlanChangeDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const current = await this.getMembership(organizationId, id, branchScope);
    if (!['ACTIVE', 'FROZEN'].includes(current.status)) throw new BadRequestException('Only active/frozen memberships can change plans');
    if (current.membershipPlanId === dto.membershipPlanId) throw new BadRequestException('Membership is already on this plan');
    if (current.nextMembership) throw new BadRequestException('Membership already has a successor');

    const nextPlan = await this.prisma.membershipPlan.findFirst({
      where: { id: dto.membershipPlanId, organizationId, isActive: true },
    });
    if (!nextPlan) throw new NotFoundException('Target membership plan not found or inactive');
    if (branchScope && nextPlan.branchId && nextPlan.branchId !== branchScope) throw new BadRequestException('Target plan is outside your assigned branch');

    const now = new Date();
    const remainingDays = Math.max(0, Math.ceil((current.endDate.getTime() - now.getTime()) / DAY));
    const dailyValue = current.price.div(current.membershipPlan.durationDays);
    const credit = dailyValue.mul(remainingDays);
    const discount = dto.discount ? new Prisma.Decimal(dto.discount) : new Prisma.Decimal(0);
    const gross = nextPlan.price.sub(discount).sub(credit);
    const finalPrice = gross.gt(0) ? gross : new Prisma.Decimal(0);
    const paymentAmount = dto.initialPayment ? new Prisma.Decimal(dto.initialPayment) : new Prisma.Decimal(0);

    const result = await this.prisma.$transaction(async (tx) => {
      const next = await tx.membership.create({
        data: {
          organizationId,
          branchId: nextPlan.branchId ?? current.branchId,
          memberId: current.memberId,
          membershipPlanId: nextPlan.id,
          status: 'ACTIVE',
          startDate: now,
          endDate: new Date(now.getTime() + nextPlan.durationDays * DAY),
          price: finalPrice,
          discount: discount.add(credit),
          currency: nextPlan.currency,
          autoRenew: current.autoRenew,
          previousMembershipId: current.id,
        },
      });
      if (paymentAmount.gt(0)) {
        await tx.payment.create({
          data: {
            organizationId,
            memberId: current.memberId,
            membershipId: next.id,
            amount: paymentAmount,
            currency: nextPlan.currency,
            method: dto.paymentMethod ?? 'CASH',
            status: PaymentStatus.COMPLETED,
          },
        });
      }
      const old = await tx.membership.update({
        where: { id: current.id },
        data: { status: 'CANCELLED', cancelledAt: now, cancellationReason: 'PLAN_CHANGE' },
      });
      return { old, next };
    });

    await this.audit(organizationId, result.next.branchId, 'membership.plan_changed', id, {
      planId: current.membershipPlanId,
      price: current.price.toString(),
      remainingDays,
    }, {
      planId: result.next.membershipPlanId,
      price: result.next.price.toString(),
      credit: credit.toString(),
      direction: nextPlan.price.gte(current.membershipPlan.price) ? 'UPGRADE' : 'DOWNGRADE',
      successorId: result.next.id,
    }, actorUserId);
    return result.next;
  }

  async transfer(
    organizationId: string,
    id: string,
    dto: TransferMembershipDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const current = await this.getMembership(organizationId, id, branchScope);
    if (current.status === 'CANCELLED') throw new BadRequestException('Cancelled membership cannot be transferred');
    if (current.nextMembership) throw new BadRequestException('Membership already has a successor');
    if (current.memberId === dto.memberId) throw new BadRequestException('Target member is already the membership owner');

    const target = await this.prisma.member.findFirst({ where: { id: dto.memberId, organizationId, deletedAt: null } });
    if (!target) throw new NotFoundException('Target member not found');
    if (branchScope && target.primaryBranchId !== branchScope) throw new BadRequestException('Target member is outside your assigned branch');

    const result = await this.prisma.$transaction(async (tx) => {
      const next = await tx.membership.create({
        data: {
          organizationId,
          branchId: target.primaryBranchId,
          memberId: target.id,
          membershipPlanId: current.membershipPlanId,
          status: current.status,
          startDate: current.startDate,
          endDate: current.endDate,
          freezeStartDate: current.freezeStartDate,
          freezeEndDate: current.freezeEndDate,
          totalFreezeDaysUsed: current.totalFreezeDaysUsed,
          price: current.price,
          discount: current.discount,
          currency: current.currency,
          autoRenew: current.autoRenew,
          previousMembershipId: current.id,
        },
      });
      await tx.payment.updateMany({
        where: { organizationId, membershipId: current.id },
        data: { membershipId: next.id, memberId: target.id, branchId: target.primaryBranchId },
      });
      const old = await tx.membership.update({
        where: { id: current.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'TRANSFERRED' },
      });
      return { old, next };
    });

    await this.audit(organizationId, result.next.branchId, 'membership.transferred', id, { memberId: current.memberId }, { memberId: result.next.memberId, successorId: result.next.id, reason: dto.reason ?? null }, actorUserId);
    return result.next;
  }

  async expireDue(organizationId: string, branchScope: string | null, actorUserId?: string) {
    const now = new Date();
    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        endDate: { lt: now },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: { id: true, branchId: true, memberId: true, endDate: true },
    });
    if (!memberships.length) return { expired: 0 };
    const result = await this.prisma.$transaction(async (tx) => tx.membership.updateMany({ where: { id: { in: memberships.map((m) => m.id) }, organizationId }, data: { status: 'EXPIRED' } }));
    for (const membership of memberships) {
      await this.audit(organizationId, membership.branchId, 'membership.expired', membership.id, { status: 'ACTIVE', endDate: membership.endDate.toISOString() }, { status: 'EXPIRED' }, actorUserId);
    }
    return { expired: result.count };
  }

  async recordPaymentFailure(
    organizationId: string,
    id: string,
    dto: PaymentFailureDto,
    branchScope: string | null,
    actorUserId?: string,
  ) {
    const membership = await this.getMembership(organizationId, id, branchScope);
    const failure = {
      amount: dto.amount ?? null,
      reason: dto.reason ?? null,
      attemptedAt: dto.attemptedAt ?? new Date().toISOString(),
    };
    await this.audit(organizationId, membership.branchId, 'membership.payment_failed', id, null, failure, actorUserId);
    this.events.emit('membership.payment_failed', { organizationId, membershipId: id, memberId: membership.memberId, ...failure });
    return { recorded: true, membershipId: id, ...failure };
  }

  async renewalReminders(organizationId: string, branchScope: string | null, days = 7) {
    const cutoff = new Date(Date.now() + days * DAY);
    return this.prisma.membership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        endDate: { gt: new Date(), lte: cutoff },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      orderBy: { endDate: 'asc' },
      include: {
        membershipPlan: true,
        member: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      },
    });
  }

  async analytics(organizationId: string, branchScope: string | null) {
    const where = { organizationId, ...(branchScope ? { branchId: branchScope } : {}) };
    const [counts, financial, expiring, overduePayments] = await Promise.all([
      this.prisma.membership.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.membership.aggregate({ where, _sum: { price: true }, _count: { _all: true } }),
      this.prisma.membership.count({ where: { ...where, status: 'ACTIVE', endDate: { gt: new Date(), lte: new Date(Date.now() + 30 * DAY) } } }),
      this.prisma.payment.count({ where: { organizationId, status: { not: PaymentStatus.COMPLETED }, ...(branchScope ? { branchId: branchScope } : {}) } }).catch(() => 0),
    ]);
    const statusCounts = Object.fromEntries(counts.map((row) => [row.status, row._count._all]));
    return {
      total: financial._count._all,
      totalContractValue: financial._sum.price ?? new Prisma.Decimal(0),
      active: statusCounts.ACTIVE ?? 0,
      frozen: statusCounts.FROZEN ?? 0,
      expired: statusCounts.EXPIRED ?? 0,
      cancelled: statusCounts.CANCELLED ?? 0,
      pending: statusCounts.PENDING ?? 0,
      expiringNext30Days: expiring,
      nonCompletedPayments: overduePayments,
    };
  }
}
