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
  ) {
    const where: Prisma.PaymentWhereInput = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(membershipId ? { membershipId } : {}),
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

  async getOne(organizationId: string, id: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id, organizationId },
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

    const payment = await this.prisma.payment.create({
      data: {
        organizationId,
        branchId: membership?.branchId ?? member.primaryBranchId,
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
  ) {
    const payment = await this.getOne(organizationId, id);
    if (payment.status === 'REFUNDED') {
      throw new BadRequestException('Payment is already fully refunded');
    }

    const alreadyRefunded = payment.refunds.reduce(
      (sum, r) => sum.plus(r.amount),
      new Prisma.Decimal(0),
    );
    const remaining = new Prisma.Decimal(payment.amount).minus(alreadyRefunded);
    const refundAmount = dto.amount
      ? new Prisma.Decimal(dto.amount)
      : remaining;

    if (refundAmount.lte(0)) {
      throw new BadRequestException('Refund amount must be greater than zero');
    }
    if (refundAmount.gt(remaining)) {
      throw new BadRequestException(
        `Refund amount exceeds the remaining refundable balance of ${remaining.toString()}`,
      );
    }

    const newStatus = refundAmount.equals(remaining)
      ? 'REFUNDED'
      : 'PARTIALLY_REFUNDED';

    const [refund] = await this.prisma.$transaction([
      this.prisma.refund.create({
        data: {
          organizationId,
          paymentId: payment.id,
          amount: refundAmount,
          reason: dto.reason,
          recordedByUserId,
        },
      }),
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: newStatus },
      }),
    ]);

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
