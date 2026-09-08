import { PaymentStatus, Prisma } from '@prisma/client';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { DomainEvent } from '../events/domain-events';
import type { ExtendMembershipDto, MembershipPlanChangeDto, PauseMembershipDto, PaymentFailureDto, TransferMembershipDto } from './dto/membership-lifecycle.dto';

const DAY = 86_400_000;

@Injectable()
export class MembershipLifecycleService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2) {}

  private async get(organizationId: string, id: string, branchScope: string | null) {
    const row = await this.prisma.membership.findFirst({ where: { id, organizationId, ...(branchScope ? { branchId: branchScope } : {}) }, include: { membershipPlan: true, member: true } });
    if (!row) throw new NotFoundException('Membership not found');
    return row;
  }

  private async successorExists(organizationId: string, id: string) {
    return (await this.prisma.membership.count({ where: { organizationId, previousMembershipId: id } })) > 0;
  }

  private audit(organizationId: string, branchId: string, action: string, id: string, beforeState: unknown, afterState: unknown, actorUserId?: string) {
    return this.prisma.auditLog.create({ data: { organizationId, branchId, actorUserId: actorUserId ?? null, action, resource: 'membership', resourceId: id, beforeState: beforeState as Prisma.InputJsonValue, afterState: afterState as Prisma.InputJsonValue } });
  }

  async activate(organizationId: string, id: string, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    if (row.status === 'ACTIVE') return row;
    if (row.status !== 'PENDING') throw new BadRequestException(`Cannot activate membership in ${row.status} state`);
    const updated = await this.prisma.membership.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.audit(organizationId, updated.branchId, 'membership.activated', id, { status: row.status }, { status: updated.status }, actorUserId);
    this.events.emit(DomainEvent.MembershipStarted, { organizationId, branchId: updated.branchId, membershipId: updated.id, memberId: updated.memberId, membershipPlanId: updated.membershipPlanId });
    return updated;
  }

  async pause(organizationId: string, id: string, dto: PauseMembershipDto, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    if (row.status !== 'ACTIVE') throw new BadRequestException('Only an active membership can be paused');
    const remaining = row.membershipPlan.maxFreezeDays - row.totalFreezeDaysUsed;
    if (dto.days > remaining) throw new BadRequestException(`Requested pause exceeds ${remaining} remaining freeze days`);
    const start = new Date(); const end = new Date(start.getTime() + dto.days * DAY);
    const updated = await this.prisma.membership.update({ where: { id }, data: { status: 'FROZEN', freezeStartDate: start, freezeEndDate: end } });
    await this.audit(organizationId, updated.branchId, 'membership.paused', id, { status: row.status }, { status: updated.status, pauseDays: dto.days, reason: dto.reason ?? null }, actorUserId);
    return updated;
  }

  async resume(organizationId: string, id: string, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    if (row.status !== 'FROZEN' || !row.freezeStartDate) throw new BadRequestException('Membership is not paused/frozen');
    const end = row.freezeEndDate && row.freezeEndDate.getTime() < Date.now() ? row.freezeEndDate : new Date();
    const days = Math.max(0, Math.ceil((end.getTime() - row.freezeStartDate.getTime()) / DAY));
    const updated = await this.prisma.membership.update({ where: { id }, data: { status: 'ACTIVE', endDate: new Date(row.endDate.getTime() + days * DAY), freezeStartDate: null, freezeEndDate: null, totalFreezeDaysUsed: row.totalFreezeDaysUsed + days } });
    await this.audit(organizationId, updated.branchId, 'membership.resumed', id, { status: row.status }, { status: updated.status, frozenDays: days }, actorUserId);
    return updated;
  }

  async extend(organizationId: string, id: string, dto: ExtendMembershipDto, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    if (row.status === 'CANCELLED') throw new BadRequestException('Cancelled membership cannot be extended');
    const updated = await this.prisma.membership.update({ where: { id }, data: { endDate: new Date(row.endDate.getTime() + dto.days * DAY) } });
    await this.audit(organizationId, updated.branchId, 'membership.extended', id, { endDate: row.endDate.toISOString() }, { endDate: updated.endDate.toISOString(), days: dto.days }, actorUserId);
    return updated;
  }

  async changePlan(organizationId: string, id: string, dto: MembershipPlanChangeDto, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    if (!['ACTIVE', 'FROZEN'].includes(row.status)) throw new BadRequestException('Only active/frozen memberships can change plans');
    if (row.membershipPlanId === dto.membershipPlanId) throw new BadRequestException('Membership is already on this plan');
    if (await this.successorExists(organizationId, id)) throw new BadRequestException('Membership already has a successor');
    const plan = await this.prisma.membershipPlan.findFirst({ where: { id: dto.membershipPlanId, organizationId, isActive: true } });
    if (!plan) throw new NotFoundException('Target membership plan not found or inactive');
    if (branchScope && plan.branchId && plan.branchId !== branchScope) throw new BadRequestException('Target plan is outside your assigned branch');
    const now = new Date();
    const remainingDays = Math.max(0, Math.ceil((row.endDate.getTime() - now.getTime()) / DAY));
    const credit = row.price.div(row.membershipPlan.durationDays).mul(remainingDays);
    const discount = dto.discount ? new Prisma.Decimal(dto.discount) : new Prisma.Decimal(0);
    const price = Prisma.Decimal.max(new Prisma.Decimal(0), plan.price.sub(discount).sub(credit));
    const paymentAmount = dto.initialPayment ? new Prisma.Decimal(dto.initialPayment) : new Prisma.Decimal(0);
    const result = await this.prisma.$transaction(async tx => {
      const next = await tx.membership.create({ data: { organizationId, branchId: plan.branchId ?? row.branchId, memberId: row.memberId, membershipPlanId: plan.id, status: 'ACTIVE', startDate: now, endDate: new Date(now.getTime() + plan.durationDays * DAY), price, discount: discount.add(credit), currency: plan.currency, autoRenew: row.autoRenew, previousMembershipId: row.id } });
      if (paymentAmount.gt(0)) await tx.payment.create({ data: { organizationId, memberId: row.memberId, membershipId: next.id, amount: paymentAmount, currency: plan.currency, method: dto.paymentMethod ?? 'CASH', status: PaymentStatus.COMPLETED } });
      await tx.membership.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now, cancellationReason: 'PLAN_CHANGE' } });
      return next;
    });
    await this.audit(organizationId, result.branchId, 'membership.plan_changed', id, { planId: row.membershipPlanId, price: row.price.toString(), remainingDays }, { planId: result.membershipPlanId, price: result.price.toString(), credit: credit.toString(), direction: plan.price.gte(row.membershipPlan.price) ? 'UPGRADE' : 'DOWNGRADE', successorId: result.id }, actorUserId);
    return result;
  }

  async transfer(organizationId: string, id: string, dto: TransferMembershipDto, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    if (row.status === 'CANCELLED') throw new BadRequestException('Cancelled membership cannot be transferred');
    if (await this.successorExists(organizationId, id)) throw new BadRequestException('Membership already has a successor');
    if (row.memberId === dto.memberId) throw new BadRequestException('Target member is already the membership owner');
    const target = await this.prisma.member.findFirst({ where: { id: dto.memberId, organizationId, deletedAt: null } });
    if (!target) throw new NotFoundException('Target member not found');
    if (branchScope && target.primaryBranchId !== branchScope) throw new BadRequestException('Target member is outside your assigned branch');
    const next = await this.prisma.$transaction(async tx => {
      const created = await tx.membership.create({ data: { organizationId, branchId: target.primaryBranchId, memberId: target.id, membershipPlanId: row.membershipPlanId, status: row.status, startDate: row.startDate, endDate: row.endDate, freezeStartDate: row.freezeStartDate, freezeEndDate: row.freezeEndDate, totalFreezeDaysUsed: row.totalFreezeDaysUsed, price: row.price, discount: row.discount, currency: row.currency, autoRenew: row.autoRenew, previousMembershipId: row.id } });
      await tx.payment.updateMany({ where: { organizationId, membershipId: row.id }, data: { membershipId: created.id, memberId: target.id, branchId: target.primaryBranchId } });
      await tx.membership.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'TRANSFERRED' } });
      return created;
    });
    await this.audit(organizationId, next.branchId, 'membership.transferred', id, { memberId: row.memberId }, { memberId: next.memberId, successorId: next.id, reason: dto.reason ?? null }, actorUserId);
    return next;
  }

  async expireDue(organizationId: string, branchScope: string | null, actorUserId?: string) {
    const now = new Date();
    const rows = await this.prisma.membership.findMany({ where: { organizationId, status: 'ACTIVE', endDate: { lt: now }, ...(branchScope ? { branchId: branchScope } : {}) }, select: { id: true, branchId: true, endDate: true } });
    if (!rows.length) return { expired: 0 };
    const result = await this.prisma.$transaction(tx => tx.membership.updateMany({ where: { organizationId, id: { in: rows.map(r => r.id) } }, data: { status: 'EXPIRED' } }));
    for (const row of rows) await this.audit(organizationId, row.branchId, 'membership.expired', row.id, { status: 'ACTIVE', endDate: row.endDate.toISOString() }, { status: 'EXPIRED' }, actorUserId);
    return { expired: result.count };
  }

  async recordPaymentFailure(organizationId: string, id: string, dto: PaymentFailureDto, branchScope: string | null, actorUserId?: string) {
    const row = await this.get(organizationId, id, branchScope);
    const failure = { amount: dto.amount ?? null, reason: dto.reason ?? null, attemptedAt: dto.attemptedAt ?? new Date().toISOString() };
    await this.audit(organizationId, row.branchId, 'membership.payment_failed', id, null, failure, actorUserId);
    this.events.emit('membership.payment_failed', { organizationId, membershipId: id, memberId: row.memberId, ...failure });
    return { recorded: true, membershipId: id, ...failure };
  }

  renewalReminders(organizationId: string, branchScope: string | null, days = 7) {
    const now = new Date(); const cutoff = new Date(now.getTime() + days * DAY);
    return this.prisma.membership.findMany({ where: { organizationId, status: 'ACTIVE', endDate: { gt: now, lte: cutoff }, ...(branchScope ? { branchId: branchScope } : {}) }, orderBy: { endDate: 'asc' }, include: { membershipPlan: true, member: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } } });
  }

  async analytics(organizationId: string, branchScope: string | null) {
    const where = { organizationId, ...(branchScope ? { branchId: branchScope } : {}) };
    const [counts, financial, expiring, nonCompletedPayments] = await Promise.all([
      this.prisma.membership.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.membership.aggregate({ where, _sum: { price: true }, _count: { _all: true } }),
      this.prisma.membership.count({ where: { ...where, status: 'ACTIVE', endDate: { gt: new Date(), lte: new Date(Date.now() + 30 * DAY) } } }),
      this.prisma.payment.count({ where: { organizationId, status: { not: PaymentStatus.COMPLETED }, ...(branchScope ? { branchId: branchScope } : {}) } }),
    ]);
    const statusCounts = Object.fromEntries(counts.map(r => [r.status, r._count._all]));
    return { total: financial._count._all, totalContractValue: financial._sum.price ?? new Prisma.Decimal(0), active: statusCounts.ACTIVE ?? 0, frozen: statusCounts.FROZEN ?? 0, expired: statusCounts.EXPIRED ?? 0, cancelled: statusCounts.CANCELLED ?? 0, pending: statusCounts.PENDING ?? 0, expiringNext30Days: expiring, nonCompletedPayments };
  }
}
