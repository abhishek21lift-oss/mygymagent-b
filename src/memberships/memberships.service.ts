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
  ) {
    const where = { organizationId, ...(memberId ? { memberId } : {}) };
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

  async getOne(organizationId: string, id: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { id, organizationId },
      include: { membershipPlan: true, member: true },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    return membership;
  }

  async create(organizationId: string, dto: CreateMembershipDto) {
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

    const startDate = dto.startDate ? new Date(dto.startDate) : new Date();
    const endDate = new Date(
      startDate.getTime() + plan.durationDays * MS_PER_DAY,
    );

    const membership = await this.prisma.membership.create({
      data: {
        organizationId,
        branchId: plan.branchId ?? member.primaryBranchId,
        memberId: member.id,
        membershipPlanId: plan.id,
        status: 'ACTIVE',
        startDate,
        endDate,
        price: plan.price,
        currency: plan.currency,
        autoRenew: dto.autoRenew ?? false,
      },
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

  async freeze(organizationId: string, id: string, dto: FreezeMembershipDto) {
    const membership = await this.getOne(organizationId, id);
    if (membership.status !== 'ACTIVE') {
      throw new BadRequestException('Only an active membership can be frozen');
    }
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

  async resume(organizationId: string, id: string) {
    const membership = await this.getOne(organizationId, id);
    if (membership.status !== 'FROZEN' || !membership.freezeStartDate) {
      throw new BadRequestException('Membership is not currently frozen');
    }

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

  async cancel(organizationId: string, id: string, dto: CancelMembershipDto) {
    const membership = await this.getOne(organizationId, id);
    if (membership.status === 'CANCELLED') {
      throw new BadRequestException('Membership is already cancelled');
    }
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
}
