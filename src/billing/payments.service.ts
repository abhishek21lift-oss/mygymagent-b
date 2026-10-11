import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
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
} from '../events/domain-events';
import { organizationTimezone, zonedBound } from '../common/time/zoned';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from '../invoices/invoices.service';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { RefundPaymentDto } from './dto/refund-payment.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly invoices: InvoicesService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    membershipId?: string,
    branchScope: string | null = null,
    /** YYYY-MM-DD, a day in the gym's timezone -- the window the
     * dashboard's Today collection counts. */
    date?: string,
  ) {
    const timezone = date
      ? await organizationTimezone(this.prisma, organizationId)
      : null;
    const where: Prisma.PaymentWhereInput = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(membershipId ? { membershipId } : {}),
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(date && timezone
        ? {
            createdAt: {
              gte: zonedBound(date, timezone, 'from'),
              lt: zonedBound(date, timezone, 'to'),
            },
          }
        : {}),
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

  async getOneByStripeIntentId(stripePaymentIntentId: string) {
    return this.prisma.payment.findFirst({
      where: { stripePaymentIntentId },
      include: {
        member: { select: { id: true, firstName: true, lastName: true } },
        membership: { include: { membershipPlan: true } },
        refunds: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async createStripePayment(
    organizationId: string,
    amount: number,
    currency: string,
    memberId?: string,
    membershipId?: string,
    stripePaymentIntentId?: string,
    recordedByUserId: string | null = null,
    status: string = 'COMPLETED',
  ) {
    // Determine branchId from member or membership
    let branchId: string | null = null;
    if (membershipId) {
      const membership = await this.prisma.membership.findFirst({
        where: { id: membershipId, organizationId },
        select: { branchId: true },
      });
      branchId = membership?.branchId ?? null;
    } else if (memberId) {
      const member = await this.prisma.member.findFirst({
        where: { id: memberId, organizationId },
        select: { primaryBranchId: true },
      });
      branchId = member?.primaryBranchId ?? null;
    }

    // Create the payment record
    const payment = await this.prisma.payment.create({
      data: {
        organizationId,
        branchId,
        memberId: memberId as string,
        membershipId,
        amount,
        currency,
        method: 'CARD', // Assuming Stripe payments are card payments
        status: status as
          'COMPLETED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED',
        stripePaymentIntentId,
        recordedByUserId,
      },
    });

    return payment;
  }

  async create(
    organizationId: string,
    dto: CreatePaymentDto,
    recordedByUserId: string | null = null,
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
    if (membership && membership.memberId !== dto.memberId) {
      throw new BadRequestException(
        'Membership does not belong to the specified member',
      );
    }
    const invoice = dto.invoiceId
      ? await this.prisma.invoice.findFirst({
          where: { id: dto.invoiceId, organizationId },
        })
      : null;
    if (dto.invoiceId && !invoice) {
      throw new NotFoundException('Invoice not found');
    }
    if (invoice && invoice.memberId !== dto.memberId) {
      throw new BadRequestException(
        'Invoice does not belong to the specified member',
      );
    }
    if (
      invoice &&
      (invoice.status === 'VOID' || invoice.status === 'WRITTEN_OFF')
    ) {
      throw new BadRequestException(
        'Cannot link a payment to a voided invoice',
      );
    }

    const branchId = membership?.branchId ?? member.primaryBranchId;
    if (branchScope && branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot record a payment for a member outside your assigned branch',
      );
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
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
      if (invoice) {
        await tx.invoicePayment.create({
          data: {
            invoiceId: invoice.id,
            paymentId: created.id,
            amount: dto.amount,
          },
        });
      }
      return created;
    });
    if (invoice) {
      await this.invoices.recomputeInvoiceStatus(invoice.id);
    } else if (membership) {
      // Paid against a membership, not a named invoice: settle it into the
      // membership's open invoice. The payment is recorded either way.
      await this.invoices
        .settleMembershipPayments(organizationId, membership.id)
        .catch((error: unknown) =>
          this.logger.warn(
            `Settling payment ${payment.id} into membership ${membership.id}'s invoice failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }

    const payload: PaymentRecordedEvent = {
      organizationId,
      branchId: payment.branchId ?? '',
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
    // Strict no-refund policy: member refunds are disabled gym-wide.
    // The scoped lookup stays first so cross-tenant or missing ids
    // still answer 404 exactly as before -- the policy refusal (410)
    // must never confirm or deny another tenant's rows.
    await this.getOne(organizationId, id, branchScope);
    // The route stays so callers get an explicit answer instead of a
    // 404, and historical Refund rows remain readable everywhere.
    void dto;
    void recordedByUserId;
    throw new GoneException(
      'Refunds are disabled under gym policy: payments are final and non-refundable',
    );
  }
}
