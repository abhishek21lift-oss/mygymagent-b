import {
  MemberStatus,
  MembershipStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
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
  type MembershipExpiredEvent,
  type MembershipStartedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CancelMembershipDto } from './dto/cancel-membership.dto';
import type { CreateMembershipDto } from './dto/create-membership.dto';
import type { ExtendMembershipDto } from './dto/extend-membership.dto';
import type { FreezeMembershipDto } from './dto/freeze-membership.dto';
import type { TransferMembershipDto } from './dto/transfer-membership.dto';
import type { ChangeMembershipPlanDto } from './dto/change-membership-plan.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Statuses under which a membership still counts as "live" for a member. */
const ACCESS_STATUSES: MembershipStatus[] = ['ACTIVE', 'FROZEN', 'PAUSED'];

/** Remaining days of a membership term, rounded up to whole days and
 * never negative. Used for upgrade/downgrade proration. */
function remainingDays(membership: { endDate: Date }): number {
  return Math.max(
    0,
    Math.ceil((membership.endDate.getTime() - Date.now()) / MS_PER_DAY),
  );
}

/** Total billable window for proration: startDate to endDate (endDate
 * already reflects granted extensions and freeze credits). */
function totalWindowDays(membership: {
  startDate: Date;
  endDate: Date;
}): number {
  return Math.max(
    1,
    Math.ceil(
      (membership.endDate.getTime() - membership.startDate.getTime()) /
        MS_PER_DAY,
    ),
  );
}

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Append-only lifecycle trail: every transition writes one row, in
   * the same transaction as the membership update it describes. */
  private recordTransition(
    tx: Prisma.TransactionClient,
    organizationId: string,
    membershipId: string,
    fromStatus: MembershipStatus | null,
    toStatus: MembershipStatus,
    detail: string | undefined,
    changedByUserId: string | null,
  ) {
    return tx.membershipStatusHistory.create({
      data: {
        organizationId,
        membershipId,
        fromStatus,
        toStatus,
        detail,
        changedByUserId,
      },
    });
  }

  /** Reads the full lifecycle trail for one membership, oldest first. */
  async getHistory(organizationId: string, membershipId: string) {
    await this.getOne(organizationId, membershipId);
    return this.prisma.membershipStatusHistory.findMany({
      where: { organizationId, membershipId },
      orderBy: { createdAt: 'asc' },
      include: {
        changedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

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

  /** Keeps a member's rollup status honest after a lifecycle change:
   * if the member holds no access-granting membership any more and
   * their status is still ACTIVE, flip them to EXPIRED with a status
   * history row, mirroring the members module's own trail pattern. */
  private async syncMemberStatusAfterExpiry(
    tx: Prisma.TransactionClient,
    organizationId: string,
    memberId: string,
  ) {
    const [member, remainingAccess] = await Promise.all([
      tx.member.findUnique({ where: { id: memberId } }),
      tx.membership.count({
        where: {
          organizationId,
          memberId,
          status: { in: ACCESS_STATUSES },
        },
      }),
    ]);
    if (!member || member.status !== 'ACTIVE' || remainingAccess > 0) return;
    await tx.member.update({
      where: { id: memberId },
      data: { status: MemberStatus.EXPIRED },
    });
    await tx.memberStatusHistory.create({
      data: {
        organizationId,
        memberId,
        fromStatus: member.status,
        toStatus: MemberStatus.EXPIRED,
        changedByUserId: null,
      },
    });
  }

  async create(
    organizationId: string,
    dto: CreateMembershipDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
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
    const discount = dto.discount
      ? new Prisma.Decimal(dto.discount)
      : new Prisma.Decimal(0);
    if (discount.lt(0) || discount.gt(plan.price)) {
      throw new BadRequestException(
        'Discount must be between 0 and the plan price',
      );
    }
    const finalPrice = plan.price.sub(discount);
    const initialPayment = dto.initialPayment
      ? new Prisma.Decimal(dto.initialPayment)
      : null;
    if (
      initialPayment &&
      (initialPayment.lt(0) || initialPayment.gt(finalPrice))
    ) {
      throw new BadRequestException(
        'Initial payment must be between 0 and the membership price',
      );
    }

    // Backward-compatible default: purchases activate immediately.
    const initialStatus: MembershipStatus =
      dto.activate === false ? 'PENDING' : 'ACTIVE';

    const membership = await this.prisma.$transaction(async (tx) => {
      const newMembership = await tx.membership.create({
        data: {
          organizationId,
          branchId,
          memberId: member.id,
          membershipPlanId: plan.id,
          status: initialStatus,
          startDate,
          endDate,
          price: finalPrice,
          discount: discount.gt(0) ? discount : null,
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

      await this.recordTransition(
        tx,
        organizationId,
        newMembership.id,
        null,
        initialStatus,
        dto.activate === false
          ? 'Purchase recorded, pending activation'
          : 'Purchased and activated',
        changedByUserId,
      );

      return newMembership;
    });

    if (initialStatus === 'ACTIVE') {
      this.events.emit(DomainEvent.MembershipStarted, {
        organizationId,
        branchId: membership.branchId,
        membershipId: membership.id,
        memberId: membership.memberId,
        membershipPlanId: membership.membershipPlanId,
      } satisfies MembershipStartedEvent);
    }
    return membership;
  }

  /** PENDING → ACTIVE. The activation step for purchases recorded with
   * activate:false (e.g. pending payment clearance or document check). */
  async activate(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const activated = await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: {
          id,
          organizationId,
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      if (membership.status !== 'PENDING') {
        throw new BadRequestException(
          `Only a pending membership can be activated (current status: ${membership.status})`,
        );
      }
      const activatedRow = await tx.membership.update({
        where: { id },
        data: { status: 'ACTIVE' },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        'PENDING',
        'ACTIVE',
        'Activated',
        changedByUserId,
      );
      return activatedRow;
    });
    this.events.emit(DomainEvent.MembershipStarted, {
      organizationId,
      branchId: activated.branchId,
      membershipId: activated.id,
      memberId: activated.memberId,
      membershipPlanId: activated.membershipPlanId,
    } satisfies MembershipStartedEvent);
    return activated;
  }

  async freeze(
    organizationId: string,
    id: string,
    dto: FreezeMembershipDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    if (dto.days <= 0) {
      throw new BadRequestException('Freeze days must be greater than zero');
    }

    return this.prisma.$transaction(
      async (tx) => {
        const membership = await tx.membership.findFirst({
          where: {
            id,
            organizationId,
            ...(branchScope ? { branchId: branchScope } : {}),
          },
          include: { membershipPlan: true },
        });
        if (!membership) throw new NotFoundException('Membership not found');
        if (membership.status !== 'ACTIVE') {
          throw new BadRequestException(
            'Only an active membership can be frozen',
          );
        }

        const remainingFreezeDays =
          membership.membershipPlan.maxFreezeDays -
          membership.totalFreezeDaysUsed;
        if (dto.days > remainingFreezeDays) {
          throw new BadRequestException(
            `Requested freeze of ${dto.days} days exceeds the ${remainingFreezeDays} remaining freeze days on this plan`,
          );
        }

        const freezeStartDate = new Date();
        const freezeEndDate = new Date(
          freezeStartDate.getTime() + dto.days * MS_PER_DAY,
        );
        const frozen = await tx.membership.update({
          where: { id },
          data: { status: 'FROZEN', freezeStartDate, freezeEndDate },
        });
        await this.recordTransition(
          tx,
          organizationId,
          id,
          'ACTIVE',
          'FROZEN',
          `Froze for ${dto.days} day(s)`,
          changedByUserId,
        );
        return frozen;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async resume(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status !== 'FROZEN' || !membership.freezeStartDate)
      throw new BadRequestException('Membership is not currently frozen');

    const effectiveResumeAt = membership.freezeEndDate
      ? new Date(Math.min(Date.now(), membership.freezeEndDate.getTime()))
      : new Date();
    const frozenDays = Math.max(
      0,
      Math.ceil(
        (effectiveResumeAt.getTime() - membership.freezeStartDate.getTime()) /
          MS_PER_DAY,
      ),
    );
    const extendedEndDate = new Date(
      membership.endDate.getTime() + frozenDays * MS_PER_DAY,
    );
    return this.prisma.$transaction(async (tx) => {
      const resumed = await tx.membership.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          endDate: extendedEndDate,
          freezeStartDate: null,
          freezeEndDate: null,
          totalFreezeDaysUsed: membership.totalFreezeDaysUsed + frozenDays,
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        'FROZEN',
        'ACTIVE',
        `Resumed; endDate extended by ${frozenDays} freeze day(s)`,
        changedByUserId,
      );
      return resumed;
    });
  }

  /** ACTIVE → PAUSED: an administrative hold, distinct from a plan
   * freeze. Pause is open-ended (no freezeEndDate) and never consumes
   * the plan's maxFreezeDays quota. endDate is untouched here; the
   * credit is computed at unpause time from actual elapsed days. */
  async pause(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
    detail: string = 'Administrative pause',
  ) {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: {
          id,
          organizationId,
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      if (membership.status !== 'ACTIVE') {
        throw new BadRequestException(
          'Only an active membership can be paused',
        );
      }
      const paused = await tx.membership.update({
        where: { id },
        data: {
          status: 'PAUSED',
          freezeStartDate: new Date(),
          freezeEndDate: null,
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        'ACTIVE',
        'PAUSED',
        detail,
        changedByUserId,
      );
      return paused;
    });
  }

  /** PAUSED → ACTIVE: endDate is extended by the actual pause duration
   * (same day-math as resume), without consuming the freeze quota. */
  async unpause(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: {
          id,
          organizationId,
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      if (membership.status !== 'PAUSED' || !membership.freezeStartDate) {
        throw new BadRequestException('Membership is not currently paused');
      }
      const pausedDays = Math.max(
        0,
        Math.ceil(
          (Date.now() - membership.freezeStartDate.getTime()) / MS_PER_DAY,
        ),
      );
      const extendedEndDate = new Date(
        membership.endDate.getTime() + pausedDays * MS_PER_DAY,
      );
      const resumed = await tx.membership.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          endDate: extendedEndDate,
          freezeStartDate: null,
          freezeEndDate: null,
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        'PAUSED',
        'ACTIVE',
        `Unpaused; endDate extended by ${pausedDays} paused day(s)`,
        changedByUserId,
      );
      return resumed;
    });
  }

  /** Grants extra days beyond the plan term (goodwill, compensation,
   * promotion). Applies to any non-terminal membership. */
  async extend(
    organizationId: string,
    id: string,
    dto: ExtendMembershipDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: {
          id,
          organizationId,
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      if (
        membership.status === 'CANCELLED' ||
        membership.status === 'EXPIRED'
      ) {
        throw new BadRequestException(
          'Cannot extend a cancelled or expired membership',
        );
      }
      const extendedEndDate = new Date(
        membership.endDate.getTime() + dto.days * MS_PER_DAY,
      );
      const extended = await tx.membership.update({
        where: { id },
        data: { endDate: extendedEndDate },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        membership.status,
        membership.status,
        `Extended by ${dto.days} day(s)${dto.reason ? `: ${dto.reason}` : ''}`,
        changedByUserId,
      );
      return extended;
    });
  }

  async cancel(
    organizationId: string,
    id: string,
    dto: CancelMembershipDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status === 'CANCELLED')
      throw new BadRequestException('Membership is already cancelled');
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const cancelledRow = await tx.membership.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: dto.reason,
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        membership.status,
        'CANCELLED',
        dto.reason ? `Cancelled: ${dto.reason}` : 'Cancelled',
        changedByUserId,
      );
      return cancelledRow;
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
      select: { id: true, price: true },
    });
    const membershipIds = memberships.map((membership) => membership.id);
    const payments = await this.prisma.payment.findMany({
      where: {
        organizationId,
        memberId,
        membershipId: { in: membershipIds },
        status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] },
      },
      select: { id: true, amount: true },
    });
    const paymentIds = payments.map((payment) => payment.id);
    const refunds = paymentIds.length
      ? await this.prisma.refund.findMany({
          where: { organizationId, paymentId: { in: paymentIds } },
          select: { amount: true },
        })
      : [];

    const totalDue = memberships.reduce(
      (sum, membership) => sum.plus(membership.price),
      new Prisma.Decimal(0),
    );
    const totalPaid = payments.reduce(
      (sum, payment) => sum.plus(payment.amount),
      new Prisma.Decimal(0),
    );
    const totalRefunded = refunds.reduce(
      (sum, refund) => sum.plus(refund.amount),
      new Prisma.Decimal(0),
    );
    const outstandingBalance = totalDue.sub(totalPaid).add(totalRefunded);
    return { totalDue, totalPaid, totalRefunded, outstandingBalance };
  }

  async renew(
    organizationId: string,
    membershipId: string,
    dto: { discount?: number } = {},
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const membership = await this.getOne(
      organizationId,
      membershipId,
      branchScope,
    );
    const isExpiredOrCancelled =
      membership.status === 'EXPIRED' || membership.status === 'CANCELLED';
    if (membership.status === 'FROZEN' || membership.status === 'PAUSED') {
      throw new BadRequestException(
        'Cannot renew a frozen or paused membership. Please resume/unpause it first.',
      );
    }
    const plan = membership.membershipPlan;
    if (isExpiredOrCancelled) {
      const discount = dto.discount
        ? new Prisma.Decimal(dto.discount)
        : new Prisma.Decimal(0);
      if (discount.lt(0) || discount.gt(plan.price)) {
        throw new BadRequestException(
          'Discount must be between 0 and the plan price',
        );
      }
      const finalPrice = plan.price.sub(discount);
      const newMembership = await this.prisma.$transaction(async (tx) => {
        const renewedRow = await tx.membership.create({
          data: {
            organizationId,
            branchId: membership.branchId,
            memberId: membership.memberId,
            membershipPlanId: plan.id,
            status: 'ACTIVE',
            startDate: new Date(),
            endDate: new Date(Date.now() + plan.durationDays * MS_PER_DAY),
            price: finalPrice,
            discount: discount.gt(0) ? discount : null,
            currency: plan.currency,
            autoRenew: membership.autoRenew,
            previousMembershipId: membership.id,
          },
        });
        await this.recordTransition(
          tx,
          organizationId,
          renewedRow.id,
          null,
          'ACTIVE',
          `Renewal of membership ${membership.id}`,
          changedByUserId,
        );
        return renewedRow;
      });
      this.events.emit(DomainEvent.MembershipStarted, {
        organizationId,
        branchId: newMembership.branchId,
        membershipId: newMembership.id,
        memberId: newMembership.memberId,
        membershipPlanId: newMembership.membershipPlanId,
      } satisfies MembershipStartedEvent);
      return newMembership;
    }
    const extendedEndDate = new Date(
      membership.endDate.getTime() + plan.durationDays * MS_PER_DAY,
    );
    return this.prisma.$transaction(async (tx) => {
      const extended = await tx.membership.update({
        where: { id: membershipId },
        data: { endDate: extendedEndDate },
      });
      await this.recordTransition(
        tx,
        organizationId,
        membershipId,
        'ACTIVE',
        'ACTIVE',
        `Renewed in place; endDate extended by ${plan.durationDays} day(s)`,
        changedByUserId,
      );
      return extended;
    });
  }

  /** Upgrade or downgrade an active membership to a different plan.
   *
   * Proration: the unused portion of the current membership is credited
   * against the new plan's price on a straight-line daily basis. The
   * current row is closed out as CANCELLED (reason records the change)
   * and a new row is created via the previousMembershipId chain, per
   * the Membership model's design comment. Only ACTIVE/PAUSED
   * memberships can change plan; frozen ones must be resumed first. */
  async changePlan(
    organizationId: string,
    id: string,
    dto: ChangeMembershipPlanDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status !== 'ACTIVE' && membership.status !== 'PAUSED') {
      throw new BadRequestException(
        'Only an active or paused membership can change plan',
      );
    }
    const [member, newPlan] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: membership.memberId, organizationId, deletedAt: null },
      }),
      this.prisma.membershipPlan.findFirst({
        where: {
          id: dto.newMembershipPlanId,
          organizationId,
          isActive: true,
        },
      }),
    ]);
    if (!member) throw new NotFoundException('Member not found');
    if (!newPlan)
      throw new NotFoundException(
        'Target membership plan not found or inactive',
      );
    if (newPlan.id === membership.membershipPlanId) {
      throw new BadRequestException(
        'Membership is already on the requested plan',
      );
    }
    if (branchScope && membership.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot change plan on a membership outside your assigned branch',
      );
    }

    // ---- Proration: straight-line daily credit for unused days ----
    const windowDays = totalWindowDays(membership);
    const daysRemaining = remainingDays(membership);
    const dailyRate = membership.price.div(windowDays);
    const credit = dailyRate.mul(daysRemaining);
    const discount = dto.discount
      ? new Prisma.Decimal(dto.discount)
      : new Prisma.Decimal(0);
    if (discount.lt(0) || discount.gt(newPlan.price)) {
      throw new BadRequestException(
        'Discount must be between 0 and the new plan price',
      );
    }
    const newPrice = newPlan.price.sub(discount);
    const amountDueRaw = newPrice.sub(credit);
    const amountDue = amountDueRaw.lt(0) ? new Prisma.Decimal(0) : amountDueRaw;
    const initialPayment = dto.initialPayment
      ? new Prisma.Decimal(dto.initialPayment)
      : null;
    if (
      initialPayment &&
      (initialPayment.lt(0) || initialPayment.gt(amountDue))
    ) {
      throw new BadRequestException(
        'Initial payment must be between 0 and the amount due after credit',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const newMembership = await tx.membership.create({
        data: {
          organizationId,
          branchId: membership.branchId,
          memberId: membership.memberId,
          membershipPlanId: newPlan.id,
          status: 'ACTIVE',
          startDate: new Date(),
          endDate: new Date(Date.now() + newPlan.durationDays * MS_PER_DAY),
          price: newPrice,
          discount: discount.gt(0) ? discount : null,
          currency: newPlan.currency,
          autoRenew: membership.autoRenew,
          previousMembershipId: membership.id,
        },
      });
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: `${dto.direction} to ${newPlan.name}`,
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        membership.id,
        membership.status,
        'CANCELLED',
        `Superseded by ${dto.direction} to plan ${newPlan.name}`,
        changedByUserId,
      );
      await this.recordTransition(
        tx,
        organizationId,
        newMembership.id,
        null,
        'ACTIVE',
        `${dto.direction} from plan ${membership.membershipPlan.name}; credit ${credit.toFixed(2)} applied, amount due ${amountDue.toFixed(2)}`,
        changedByUserId,
      );
      if (initialPayment && initialPayment.gt(0)) {
        await tx.payment.create({
          data: {
            organizationId,
            memberId: membership.memberId,
            membershipId: newMembership.id,
            amount: initialPayment,
            currency: newPlan.currency,
            method: dto.paymentMethod ?? 'CASH',
            status: PaymentStatus.COMPLETED,
          },
        });
      }
      return { newMembership, credit, amountDue };
    });

    this.events.emit(DomainEvent.MembershipStarted, {
      organizationId,
      branchId: result.newMembership.branchId,
      membershipId: result.newMembership.id,
      memberId: result.newMembership.memberId,
      membershipPlanId: result.newMembership.membershipPlanId,
    } satisfies MembershipStartedEvent);
    return result;
  }

  /** Transfers a live membership to another member of the same
   * organization. The current row is closed out as CANCELLED (reason
   * records the transfer) and a new row is created for the recipient
   * via the previousMembershipId chain, per the Membership model's
   * design comment. Payments made by the original member stay attached
   * to the original row — monetary settlement between the two members
   * is a bookkeeping decision left to the org (refund + re-record),
   * never a silent balance move. */
  async transfer(
    organizationId: string,
    id: string,
    dto: TransferMembershipDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (
      membership.status !== 'ACTIVE' &&
      membership.status !== 'FROZEN' &&
      membership.status !== 'PAUSED'
    ) {
      throw new BadRequestException(
        'Only a live membership (active, frozen or paused) can be transferred',
      );
    }
    if (membership.endDate.getTime() <= Date.now()) {
      throw new BadRequestException(
        'Cannot transfer a membership whose term has already ended',
      );
    }
    const toMember = await this.prisma.member.findFirst({
      where: {
        id: dto.toMemberId,
        organizationId,
        deletedAt: null,
      },
    });
    if (!toMember) throw new NotFoundException('Target member not found');
    if (toMember.id === membership.memberId) {
      throw new BadRequestException(
        'Membership already belongs to the target member',
      );
    }
    if (branchScope && membership.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot transfer a membership outside your assigned branch',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const transferred = await tx.membership.create({
        data: {
          organizationId,
          branchId: membership.branchId,
          memberId: toMember.id,
          membershipPlanId: membership.membershipPlanId,
          status: membership.status,
          startDate: new Date(),
          endDate: membership.endDate,
          price: membership.price,
          discount: membership.discount,
          currency: membership.currency,
          autoRenew: membership.autoRenew,
          previousMembershipId: membership.id,
        },
      });
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason:
            `Transferred to ${toMember.firstName} ${toMember.lastName}`.trim(),
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        membership.id,
        membership.status,
        'CANCELLED',
        `Transferred to member ${toMember.id}${dto.reason ? `: ${dto.reason}` : ''}`,
        changedByUserId,
      );
      await this.recordTransition(
        tx,
        organizationId,
        transferred.id,
        null,
        transferred.status,
        `Transferred from member ${membership.memberId}${dto.reason ? `: ${dto.reason}` : ''}`,
        changedByUserId,
      );
      return transferred;
    });

    if (result.status === 'ACTIVE') {
      this.events.emit(DomainEvent.MembershipStarted, {
        organizationId,
        branchId: result.branchId,
        membershipId: result.id,
        memberId: result.memberId,
        membershipPlanId: result.membershipPlanId,
      } satisfies MembershipStartedEvent);
    }
    return result;
  }

  /** Flips a past-endDate ACTIVE membership to EXPIRED, records the
   * transition trail, syncs the member's rollup status, and emits
   * MembershipExpired. Shared by the expiry scanner. Runs in one
   * transaction so a crash can never leave a half-expired state. */
  async expire(
    organizationId: string,
    id: string,
    changedByUserId: string | null = null,
  ) {
    const expired = await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { id, organizationId, status: 'ACTIVE' },
      });
      if (!membership) return null;
      if (membership.endDate.getTime() > Date.now()) return null;
      const expiredRow = await tx.membership.update({
        where: { id },
        data: { status: 'EXPIRED' },
      });
      await this.recordTransition(
        tx,
        organizationId,
        id,
        'ACTIVE',
        'EXPIRED',
        'Term ended; expired automatically',
        changedByUserId,
      );
      await this.syncMemberStatusAfterExpiry(
        tx,
        organizationId,
        membership.memberId,
      );
      return expiredRow;
    });
    if (expired) {
      const payload: MembershipExpiredEvent = {
        organizationId,
        membershipId: expired.id,
        memberId: expired.memberId,
        membershipPlanId: expired.membershipPlanId,
        endDate: expired.endDate.toISOString(),
      };
      this.events.emit(DomainEvent.MembershipExpired, payload);
    }
    return expired;
  }

  /** Expiry sweep used by the automation scanner: expires every ACTIVE
   * membership of the org whose endDate has passed. Idempotent and
   * safe to re-run. */
  async expireAllDue(organizationId: string): Promise<number> {
    const due = await this.prisma.membership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        endDate: { lte: new Date() },
      },
      select: { id: true },
    });
    let count = 0;
    for (const membership of due) {
      const expired = await this.expire(organizationId, membership.id);
      if (expired) count++;
    }
    return count;
  }
}
