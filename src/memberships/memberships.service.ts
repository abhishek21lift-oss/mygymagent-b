import { PaymentStatus, Prisma } from '@prisma/client';
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
}
