import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import {
  DomainEvent,
  type PaymentRecordedEvent,
  type PaymentRefundedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { RefundPaymentDto } from './dto/refund-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    membershipId?: string,
    branchScope: string | null = null,
  ) {
    const where: Prisma.PaymentWhereInput = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(membershipId ? { membershipId } : {}),
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
          refunds: true,
        },
      }),
      this.prisma.payment.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: {
        member: { select: { id: true, firstName: true, lastName: true } },
        membership: { include: { membershipPlan: true } },
        refunds: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async create(
    organizationId: string,
    dto: CreatePaymentDto,
    recordedByUserId: string,
    branchScope: string | null = null,
  ) {
    const [organization, member, membership] = await Promise.all([
      this.prisma.organization.findFirst({ where: { id: organizationId } }),
      this.prisma.member.findFirst({
        where: { id: dto.memberId, organizationId, deletedAt: null },
      }),
      dto.membershipId
        ? this.prisma.membership.findFirst({
            where: { id: dto.membershipId, organizationId },
          })
        : Promise.resolve(null),
    ]);
    if (!organization) throw new NotFoundException('Organization not found');
    if (!member) throw new NotFoundException('Member not found');
    if (dto.membershipId && !membership) {
      throw new NotFoundException('Membership not found');
    }
    if (membership && membership.memberId !== member.id) {
      throw new BadRequestException(
        'Membership does not belong to the specified member',
      );
    }

    const branchId = membership?.branchId ?? member.primaryBranchId;
    if (branchScope && branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot record a payment for a member outside your assigned branch',
      );
    }

    const payment = await this.prisma.payment.create({
      data: {
        organizationId,
        branchId,
        memberId: member.id,
        membershipId: membership?.id,
        amount: dto.amount,
        currency: dto.currency ?? organization.currency,
        method: dto.method ?? 'CASH',
        note: dto.note,
        recordedByUserId,
      },
    });

    const payload: PaymentRecordedEvent = {
      organizationId,
      branchId: payment.branchId,
      paymentId: payment.id,
      memberId: payment.memberId,
      membershipId: payment.membershipId ?? undefined,
      amount: payment.amount.toString(),
      currency: payment.currency,
    };
    this.events.emit(DomainEvent.PaymentRecorded, payload);
    return payment;
  }

  async refund(
    organizationId: string,
    id: string,
    dto: RefundPaymentDto,
    recordedByUserId: string,
    branchScope: string | null = null,
  ) {
    const payment = await this.getOne(organizationId, id, branchScope);
    if (payment.status === 'REFUNDED') {
      throw new BadRequestException('Payment is already fully refunded');
    }

    const refund = await this.prisma.$transaction(async (tx) => {
      // Row-lock the payment for the rest of this transaction so a second,
      // concurrent refund() call against the *same* payment blocks here
      // instead of racing it: without this, two simultaneous requests can
      // both read the same "already refunded" total computed outside a
      // transaction, both pass the remaining-balance check below, and both
      // commit -- over-refunding the payment past its original amount.
      // This is a deliberate, narrow exception to the codebase's
      // no-raw-SQL convention (see docs/security/overview.md) -- Prisma's
      // query builder has no equivalent of `SELECT ... FOR UPDATE`, which
      // is the standard tool for exactly this problem.
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id} FOR UPDATE`;

      const refunds = await tx.refund.findMany({
        where: { paymentId: payment.id },
        select: { amount: true },
      });
      const alreadyRefunded = refunds.reduce(
        (sum, r) => sum.plus(r.amount),
        new Prisma.Decimal(0),
      );
      const remaining = new Prisma.Decimal(payment.amount).minus(
        alreadyRefunded,
      );
      const refundAmount = dto.amount
        ? new Prisma.Decimal(dto.amount)
        : remaining;

      if (refundAmount.lte(0)) {
        throw new BadRequestException(
          'Refund amount must be greater than zero',
        );
      }
      if (refundAmount.gt(remaining)) {
        throw new BadRequestException(
          `Refund amount exceeds the remaining refundable balance of ${remaining.toString()}`,
        );
      }

      const newStatus = refundAmount.equals(remaining)
        ? 'REFUNDED'
        : 'PARTIALLY_REFUNDED';

      const created = await tx.refund.create({
        data: {
          organizationId,
          paymentId: payment.id,
          amount: refundAmount,
          reason: dto.reason,
          recordedByUserId,
        },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: newStatus },
      });
      return created;
    });

    const payload: PaymentRefundedEvent = {
      organizationId,
      paymentId: payment.id,
      refundId: refund.id,
      memberId: payment.memberId,
      amount: refund.amount.toString(),
    };
    this.events.emit(DomainEvent.PaymentRefunded, payload);
    return refund;
  }
}
