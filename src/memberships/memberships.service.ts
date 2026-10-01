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
  type PaymentRecordedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CancelMembershipDto } from './dto/cancel-membership.dto';
import type { CreateMembershipDto } from './dto/create-membership.dto';
import type { FreezeMembershipDto } from './dto/freeze-membership.dto';
import { organizationTimezone, zonedBound } from '../common/time/zoned';
import { bookedFreezeDays } from './freeze-days';
import { shiftLaterTerms } from './later-terms';
import {
  COLLECTED_PAYMENT_STATUSES,
  membershipBalances,
} from './membership-balance';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A discount is money off the plan price: it can be the whole price, never
 * more -- a larger one used to save a negative membership price. */
function discountOff(
  price: Prisma.Decimal,
  discount: number | undefined,
): Prisma.Decimal | null {
  if (!discount) return null;
  const off = new Prisma.Decimal(discount);
  if (off.gt(price)) {
    throw new BadRequestException(
      `Discount of ${off.toFixed(2)} is more than the plan price of ${price.toFixed(2)}`,
    );
  }
  return off;
}

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
    // A bare date is that day in the gym's timezone; read as UTC it began
    // at 05:30 in India, and the term ended 05:30 into its last day.
    const startDate = dto.startDate
      ? zonedBound(
          dto.startDate,
          await organizationTimezone(this.prisma, organizationId),
          'from',
        )
      : new Date();
    const endDate = new Date(
      startDate.getTime() + plan.durationDays * MS_PER_DAY,
    );
    const discount = discountOff(plan.price, dto.discount);
    const finalPrice = discount ? plan.price.sub(discount) : plan.price;
    const initialPayment = dto.initialPayment
      ? new Prisma.Decimal(dto.initialPayment)
      : null;

    let payment: { id: string; amount: Prisma.Decimal } | null = null;
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
        payment = await this.recordInitialPayment(tx, newMembership, {
          amount: initialPayment,
          method: dto.paymentMethod,
        });
      }

      return newMembership;
    });

    this.announceStart(membership, payment);
    return membership;
  }

  /**
   * The payment taken at the desk with a sale, renewal or plan change.
   * Carries the membership's branch, like every other payment -- without
   * it the branch's revenue never showed it.
   */
  private recordInitialPayment(
    tx: Prisma.TransactionClient,
    membership: {
      id: string;
      organizationId: string;
      branchId: string;
      memberId: string;
      currency: string;
    },
    input: { amount: Prisma.Decimal; method?: PaymentMethod },
  ) {
    return tx.payment.create({
      data: {
        organizationId: membership.organizationId,
        branchId: membership.branchId,
        memberId: membership.memberId,
        membershipId: membership.id,
        amount: input.amount,
        currency: membership.currency,
        method: input.method ?? PaymentMethod.CASH,
        status: PaymentStatus.COMPLETED,
      },
      select: { id: true, amount: true },
    });
  }

  /**
   * Post-commit: `membership.started` raises the invoice (which settles
   * against any payment already taken), and a payment taken with it is
   * announced like any desk payment, so the member gets the receipt.
   */
  private announceStart(
    membership: {
      id: string;
      organizationId: string;
      branchId: string;
      memberId: string;
      membershipPlanId: string;
      currency: string;
    },
    payment: { id: string; amount: Prisma.Decimal } | null,
  ): void {
    const started: MembershipStartedEvent = {
      organizationId: membership.organizationId,
      branchId: membership.branchId,
      membershipId: membership.id,
      memberId: membership.memberId,
      membershipPlanId: membership.membershipPlanId,
    };
    this.events.emit(DomainEvent.MembershipStarted, started);
    if (!payment) return;
    const recorded: PaymentRecordedEvent = {
      organizationId: membership.organizationId,
      branchId: membership.branchId,
      paymentId: payment.id,
      memberId: membership.memberId,
      membershipId: membership.id,
      amount: payment.amount.toString(),
      currency: membership.currency,
    };
    this.events.emit(DomainEvent.PaymentRecorded, recorded);
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
    if (membership.startDate.getTime() > Date.now())
      throw new BadRequestException(
        "This term hasn't started yet -- freeze the one that is running now.",
      );
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
    // Days actually frozen, never more than were booked: a freeze left
    // running past its end used to credit every day since.
    const elapsed = Math.ceil(
      (Date.now() - membership.freezeStartDate.getTime()) / MS_PER_DAY,
    );
    const frozenDays = membership.freezeEndDate
      ? Math.min(
          elapsed,
          bookedFreezeDays(
            membership.freezeStartDate,
            membership.freezeEndDate,
          ),
        )
      : elapsed;
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
      // The renewal already sold starts later by the same days.
      await shiftLaterTerms(
        tx,
        id,
        membership.endDate,
        frozenDays * MS_PER_DAY,
      );
      return resumed;
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

  /** What a member owes across their memberships -- see
   * membershipBalances for the one definition every screen uses. */
  async getOutstandingBalance(organizationId: string, memberId: string) {
    const [memberships, payments] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId, memberId },
        select: { id: true, price: true, status: true },
      }),
      this.prisma.payment.findMany({
        where: { organizationId, memberId },
        select: {
          amount: true,
          status: true,
          membershipId: true,
          refunds: { select: { amount: true } },
        },
      }),
    ]);
    const { total } = membershipBalances(memberships, payments);
    return {
      totalDue: total.due,
      totalPaid: total.paid.minus(total.refunded),
      outstandingBalance: total.outstanding,
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
    const discount = discountOff(plan.price, dto.discount);
    // A closed membership starts a new term today. A running one starts
    // the next term the day it ends -- that used to only push the end date
    // out, a whole extra term with no price, no invoice and no payment.
    const startDate = isExpiredOrCancelled ? new Date() : membership.endDate;
    // One renewal per term, even for a double-tap: the row is locked, so a
    // second request waits, then sees the first one's renewal.
    const newMembership = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memberships WHERE id = ${membership.id} FOR UPDATE`;
      const next = await tx.membership.findFirst({
        where: {
          organizationId,
          previousMembershipId: membership.id,
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      });
      if (next) {
        throw new BadRequestException(
          'This membership has already been renewed -- renew the newer term instead.',
        );
      }
      return tx.membership.create({
        data: {
          organizationId,
          branchId: membership.branchId,
          memberId: membership.memberId,
          membershipPlanId: plan.id,
          status: 'ACTIVE',
          startDate,
          endDate: new Date(
            startDate.getTime() + plan.durationDays * MS_PER_DAY,
          ),
          price: discount ? plan.price.sub(discount) : plan.price,
          discount,
          currency: plan.currency,
          autoRenew: membership.autoRenew,
          previousMembershipId: membership.id,
        },
      });
    });
    // Post-commit like create(): the invoice auto-raise listener treats
    // every started membership the same, whether first sale or renewal.
    this.announceStart(newMembership, null);
    return newMembership;
  }

  /**
   * Headline counts for the membership lifecycle screen. All from real
   * Membership rows -- see MembershipLifecycleService for the deeper
   * funnel (rates, tenure, per-currency outstanding).
   */
  async getAnalyticsSummary(
    organizationId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ): Promise<Record<string, number | string>> {
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(assignmentScope
        ? { member: { assignedTrainerId: assignmentScope } }
        : {}),
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
    assignmentScope: string | null = null,
  ) {
    const now = new Date();
    const horizon = new Date(now.getTime() + days * MS_PER_DAY);
    return this.prisma.membership.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(assignmentScope
          ? { member: { assignedTrainerId: assignmentScope } }
          : {}),
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
    assignmentScope: string | null = null,
  ) {
    // getOne already enforces both scopes and 404s outside them, so passing
    // the assignment scope through is what keeps a trainer from reading the
    // audit trail of a membership belonging to someone else's client.
    await this.getOne(
      organizationId,
      membershipId,
      branchScope,
      assignmentScope,
    );
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
    return this.prisma.$transaction(async (tx) => {
      const extended = await tx.membership.update({
        where: { id },
        data: {
          endDate: new Date(
            membership.endDate.getTime() + dto.days * MS_PER_DAY,
          ),
        },
      });
      await shiftLaterTerms(tx, id, membership.endDate, dto.days * MS_PER_DAY);
      return extended;
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
      paymentMethod?: PaymentMethod;
    },
    branchScope: string | null = null,
  ) {
    const membership = await this.getOne(organizationId, id, branchScope);
    if (membership.status === 'CANCELLED' || membership.status === 'EXPIRED')
      throw new BadRequestException(
        'Cannot change the plan of a closed membership. Renew it instead.',
      );
    // The new plan starts today. For a term that hasn't begun, or one
    // already renewed, that would run two terms side by side.
    if (membership.startDate.getTime() > Date.now())
      throw new BadRequestException(
        "This term hasn't started yet. Cancel it and sell the new plan instead.",
      );
    const renewedAlready = await this.prisma.membership.findFirst({
      where: {
        organizationId,
        previousMembershipId: membership.id,
        status: { not: 'CANCELLED' },
      },
      select: { id: true },
    });
    if (renewedAlready)
      throw new BadRequestException(
        'This membership has already been renewed. Cancel the renewal first, then change the plan.',
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
    // Credit is the unused share of what was actually paid on the old
    // term -- crediting an unpaid term's value would hand it out free.
    const paidOnOld = await this.netPaidOn(organizationId, membership.id);
    const creditBase = Prisma.Decimal.min(membership.price, paidOnOld);
    const credit =
      totalMs > 0 && creditBase.gt(0)
        ? creditBase.mul(remainingMs).div(totalMs).toDecimalPlaces(2)
        : new Prisma.Decimal(0);
    const discount =
      discountOff(plan.price, dto.discount) ?? new Prisma.Decimal(0);
    const amountDue = Prisma.Decimal.max(
      plan.price.sub(credit).sub(discount),
      new Prisma.Decimal(0),
    );
    // The new term is priced at what is actually owed for it. The credit
    // rides in `discount` (price + discount = plan price, which is what
    // the auto-raised invoice shows as its line); before, the new row
    // was priced at the full plan and the credit existed only in this
    // response, so the member's balance charged them twice.
    const offPlan = plan.price.sub(amountDue);
    const initialPayment = dto.initialPayment
      ? new Prisma.Decimal(dto.initialPayment)
      : null;

    let payment: { id: string; amount: Prisma.Decimal } | null = null;
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
          startDate: new Date(now),
          endDate: new Date(now + plan.durationDays * MS_PER_DAY),
          price: amountDue,
          discount: offPlan.gt(0) ? offPlan : null,
          currency: plan.currency,
          autoRenew: membership.autoRenew,
          previousMembershipId: membership.id,
        },
      });
      if (initialPayment && initialPayment.gt(0)) {
        payment = await this.recordInitialPayment(tx, newMembership, {
          amount: initialPayment,
          method: dto.paymentMethod,
        });
      }
      return newMembership;
    });

    // Every started term gets its invoice, a plan change included -- it
    // used to get none.
    this.announceStart(result, payment);
    return {
      newMembership: result,
      credit: credit.toFixed(2),
      amountDue: amountDue.toFixed(2),
    };
  }

  /** Money kept on one membership: collected payments net of refunds. */
  private async netPaidOn(
    organizationId: string,
    membershipId: string,
  ): Promise<Prisma.Decimal> {
    const payments = await this.prisma.payment.findMany({
      where: {
        organizationId,
        membershipId,
        status: { in: [...COLLECTED_PAYMENT_STATUSES] },
      },
      select: { amount: true, refunds: { select: { amount: true } } },
    });
    return payments.reduce(
      (sum, payment) =>
        payment.refunds.reduce(
          (net, refund) => net.minus(refund.amount),
          sum.plus(payment.amount),
        ),
      new Prisma.Decimal(0),
    );
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
    if (membership.status === 'CANCELLED' || membership.status === 'EXPIRED')
      throw new BadRequestException(
        'Only a running membership can be transferred.',
      );
    // A branch-scoped caller hands the term only to a member of their own
    // branch: it used to reach any member in the organization.
    const target = await this.prisma.member.findFirst({
      where: {
        id: dto.memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
    });
    if (!target) throw new NotFoundException('Target member not found');
    if (target.id === membership.memberId)
      throw new BadRequestException('Membership is already with this member');
    // The renewal already sold would stay with the first member and
    // carry on the term the second one now holds.
    const renewal = await this.prisma.membership.findFirst({
      where: {
        organizationId,
        previousMembershipId: membership.id,
        status: { not: 'CANCELLED' },
      },
      select: { id: true },
    });
    if (renewal)
      throw new BadRequestException(
        'This membership has already been renewed. Cancel the renewal first, then transfer it.',
      );
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
