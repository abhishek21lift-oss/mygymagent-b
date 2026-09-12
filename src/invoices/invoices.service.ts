import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaymentMethod } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { CommunicationsService } from '../communications/communications.service';
import type { MembershipStartedEvent } from '../events/domain-events';
import { RazorpayService } from '../payments/razorpay.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateInvoiceDto } from './dto/create-invoice.dto';
import type { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days past dueAt before an unpaid invoice counts as OVERDUE -- shared by
 * recomputeInvoiceStatus() and the dunning scanner so the two can never
 * disagree about when "overdue" starts. */
export const OVERDUE_GRACE_DAYS = 7;

const COLLECTIBLE_STATUSES = ['ISSUED', 'PART_PAID', 'OVERDUE'] as const;

const invoiceIncludes = {
  member: { select: { id: true, firstName: true, lastName: true } },
  membership: { include: { membershipPlan: true } },
  paymentLinks: {
    include: { payment: true },
    orderBy: { createdAt: 'desc' as const },
  },
  dunningAttempts: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly communications: CommunicationsService,
  ) {}

  // -- reads ---------------------------------------------------------------

  async list(
    organizationId: string,
    query: ListInvoicesQueryDto,
    branchScope: string | null = null,
  ) {
    const where: Prisma.InvoiceWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(query.overdue
        ? {
            dueAt: { lt: new Date() },
            status: { in: ['ISSUED', 'PART_PAID'] },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        ...skipTake(query as PaginationQueryDto),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
          paymentLinks: {
            select: { amount: true, payment: { select: { status: true } } },
          },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return paginate(
      items.map((invoice) => ({
        ...invoice,
        outstanding: this.outstandingOf(invoice).toFixed(2),
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: invoiceIncludes,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return {
      ...invoice,
      outstanding: this.outstandingOf(invoice).toFixed(2),
    };
  }

  // -- creation ------------------------------------------------------------

  async create(
    organizationId: string,
    dto: CreateInvoiceDto,
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

    let branchId =
      dto.branchId ?? membership?.branchId ?? member.primaryBranchId;
    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: dto.branchId, organizationId },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Branch not found');
      branchId = branch.id;
    }
    if (branchScope && branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot raise an invoice for a member outside your assigned branch',
      );
    }

    // Totals are always derived here from lines/discount/taxBreakup --
    // client-supplied totals don't exist on the DTO by design.
    const lines = dto.lines.map((line) => ({
      label: line.label,
      amount: new Prisma.Decimal(line.amount).toFixed(2),
      qty: line.qty ?? 1,
    }));
    const subtotal = dto.lines.reduce(
      (sum, line) =>
        sum.plus(new Prisma.Decimal(line.amount).mul(line.qty ?? 1)),
      new Prisma.Decimal(0),
    );
    const discountTotal = new Prisma.Decimal(dto.discount ?? 0);
    if (discountTotal.gt(subtotal)) {
      throw new BadRequestException(
        'Discount cannot exceed the invoice subtotal',
      );
    }
    const taxBreakup = (dto.taxBreakup ?? []).map((entry) => ({
      label: entry.label,
      ...(entry.rate !== undefined ? { rate: entry.rate } : {}),
      amount: new Prisma.Decimal(entry.amount).toFixed(2),
    }));
    const taxTotal = (dto.taxBreakup ?? []).reduce(
      (sum, entry) => sum.plus(new Prisma.Decimal(entry.amount)),
      new Prisma.Decimal(0),
    );
    const grandTotal = subtotal.minus(discountTotal).plus(taxTotal);

    // The number and the invoice are born in one interactive transaction:
    // the upserted sequence row serializes concurrent creators for this
    // org (the row lock is the SELECT ... FOR UPDATE equivalent Prisma's
    // builder can't express), and a crash between allocating the number
    // and inserting the invoice rolls both back -- no burnt numbers.
    return this.prisma.$transaction(async (tx) => {
      const sequence = await tx.invoiceSequence.upsert({
        where: { organizationId },
        create: { organizationId, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      });
      const number = `INV-${new Date().getFullYear()}-${String(
        sequence.lastNumber,
      ).padStart(4, '0')}`;
      const issued = !dto.draft;
      const now = new Date();
      return tx.invoice.create({
        data: {
          organizationId,
          branchId,
          memberId: member.id,
          membershipId: membership?.id,
          number,
          status: issued ? 'ISSUED' : 'DRAFT',
          subtotal,
          discountTotal,
          taxTotal,
          grandTotal,
          currency: organization.currency,
          lines,
          ...(taxBreakup.length > 0 ? { taxBreakup } : {}),
          issuedAt: issued ? now : null,
          dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    });
  }

  // -- void ----------------------------------------------------------------

  async void(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const invoice = await this.getOne(organizationId, id, branchScope);
    if (invoice.status === 'VOID') return invoice;
    if (invoice.status === 'WRITTEN_OFF') {
      throw new BadRequestException('A written-off invoice cannot be voided');
    }
    if (invoice.paymentLinks.length > 0) {
      throw new ConflictException(
        'Invoice has linked payments and cannot be voided -- issue a refund against the payments instead',
      );
    }
    return this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'VOID', voidedAt: new Date() },
    });
  }

  // -- online collection ---------------------------------------------------

  async retryCollection(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const invoice = await this.getOne(organizationId, id, branchScope);
    if (!(COLLECTIBLE_STATUSES as readonly string[]).includes(invoice.status)) {
      throw new BadRequestException(
        `Only an issued, partially-paid, or overdue invoice can be collected -- this one is ${invoice.status}`,
      );
    }
    const outstanding = new Prisma.Decimal(invoice.outstanding);
    if (outstanding.lte(0)) {
      throw new BadRequestException('Invoice has no outstanding balance');
    }
    this.razorpay.ensureConfigured();

    const amountPaise = outstanding.mul(100).round().toNumber();
    const order = await this.razorpay.createOrder({
      amount: amountPaise,
      currency: invoice.currency,
      receipt: invoice.number,
      notes: { invoiceId: invoice.id, organizationId },
    });
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { providerOrderId: order.id },
    });
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      outstanding: outstanding.toFixed(2),
      currency: invoice.currency,
      keyId: this.razorpay.getKeyId(),
      order: { id: order.id, amount: order.amount, currency: order.currency },
    };
  }

  /**
   * Records a captured Razorpay payment against an invoice: one immutable
   * Payment row, one InvoicePayment link, a status recompute, and a
   * best-effort receipt email. Idempotent on `providerPaymentId` -- a
   * duplicate or out-of-order `payment.captured` delivery resolves to the
   * existing Payment instead of double-counting.
   */
  async applyOnlineCapture(
    organizationId: string,
    invoiceId: string,
    input: {
      providerPaymentId: string;
      amountRupees: Prisma.Decimal;
      currency: string;
      method: PaymentMethod;
    },
  ) {
    const existing = await this.prisma.payment.findUnique({
      where: { providerPaymentId: input.providerPaymentId },
    });
    if (existing) {
      this.logger.log(
        `Razorpay payment ${input.providerPaymentId} already recorded -- ignoring duplicate delivery`,
      );
      return { payment: existing, duplicate: true as const, invoice: null };
    }

    let payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({
          where: { id: invoiceId, organizationId },
        });
        if (!invoice) throw new NotFoundException('Invoice not found');
        const created = await tx.payment.create({
          data: {
            organizationId,
            branchId: invoice.branchId,
            memberId: invoice.memberId,
            membershipId: invoice.membershipId,
            amount: input.amountRupees,
            currency: input.currency,
            method: input.method,
            status: 'COMPLETED',
            providerPaymentId: input.providerPaymentId,
          },
        });
        await tx.invoicePayment.create({
          data: {
            invoiceId: invoice.id,
            paymentId: created.id,
            amount: input.amountRupees,
          },
        });
        return created;
      });
    } catch (error) {
      // Lost a race with a concurrent delivery of the same event -- the
      // unique constraint kept us honest; resolve to the winner's row.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.payment.findUnique({
          where: { providerPaymentId: input.providerPaymentId },
        });
        this.logger.log(
          `Razorpay payment ${input.providerPaymentId} raced a concurrent delivery -- resolved to the existing row`,
        );
        return { payment: winner, duplicate: true as const, invoice: null };
      }
      throw error;
    }

    const invoice = await this.recomputeInvoiceStatus(invoiceId);

    try {
      const member = await this.prisma.member.findFirst({
        where: { id: payment.memberId, organizationId },
        select: { id: true, email: true, firstName: true },
      });
      const full = await this.prisma.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        select: { number: true },
      });
      if (member?.email && full) {
        await this.communications.sendPaymentReceipt(
          organizationId,
          member.id,
          member.email,
          {
            firstName: member.firstName,
            amount: input.amountRupees.toFixed(2),
            currency: input.currency,
            invoiceNumber: full.number,
            paymentId: payment.id,
          },
        );
      }
    } catch (error) {
      // The money is already recorded and linked -- a receipt failure must
      // never fail the webhook (Razorpay would just retry the delivery).
      this.logger.warn(
        `Payment receipt for invoice ${invoiceId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { payment, duplicate: false as const, invoice };
  }

  // -- status --------------------------------------------------------------

  /**
   * Derives an invoice's status from its linked payments vs. grandTotal.
   * FAILED payments never count toward what's paid (spec's refund note:
   * use `status != FAILED` rather than subtracting refund rows). Called
   * after every link; terminal states (VOID/WRITTEN_OFF) and DRAFT are
   * never moved by this -- those are staff decisions, not derived facts.
   */
  async recomputeInvoiceStatus(invoiceId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Row-lock the invoice for the rest of this transaction so two
      // concurrent captures can't both read the same paid total and both
      // conclude PART_PAID -- same narrow raw-SQL exception as
      // PaymentsService.refund(), which Prisma's builder can't express.
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          paymentLinks: {
            select: {
              amount: true,
              payment: { select: { status: true } },
            },
          },
        },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (
        invoice.status === 'VOID' ||
        invoice.status === 'WRITTEN_OFF' ||
        invoice.status === 'DRAFT'
      ) {
        return invoice;
      }

      const paid = this.paidTotalOf(invoice);
      const total = new Prisma.Decimal(invoice.grandTotal);
      const now = new Date();
      let status = invoice.status;
      let paidAt: Date | null = invoice.paidAt;
      if (paid.gte(total)) {
        status = 'PAID';
        paidAt = invoice.paidAt ?? now;
      } else if (paid.gt(0)) {
        status = 'PART_PAID';
        paidAt = null;
      } else {
        status = this.isPastGrace(invoice.dueAt, now) ? 'OVERDUE' : 'ISSUED';
        paidAt = null;
      }
      if (
        status === invoice.status &&
        +(paidAt?.getTime() ?? 0) === +(invoice.paidAt?.getTime() ?? 0)
      ) {
        return invoice;
      }
      return tx.invoice.update({
        where: { id: invoiceId },
        data: { status, paidAt },
      });
    });
  }

  // -- membership auto-raise -----------------------------------------------

  /**
   * Raises (and immediately issues) an invoice for a freshly started
   * membership from plan price minus discount. Called by the
   * MembershipInvoiceListener post-commit -- failures are logged here and
   * never propagate, so invoicing can never break the membership flow.
   */
  async createFromMembership(event: MembershipStartedEvent): Promise<void> {
    try {
      const duplicate = await this.prisma.invoice.findFirst({
        where: {
          organizationId: event.organizationId,
          membershipId: event.membershipId,
        },
        select: { id: true },
      });
      if (duplicate) return;
      const membership = await this.prisma.membership.findFirst({
        where: { id: event.membershipId, organizationId: event.organizationId },
        include: { membershipPlan: true },
      });
      if (!membership) {
        this.logger.warn(
          `Skipping auto-invoice: membership ${event.membershipId} not found`,
        );
        return;
      }
      await this.create(event.organizationId, {
        memberId: membership.memberId,
        membershipId: membership.id,
        branchId: membership.branchId,
        lines: [
          {
            label: membership.membershipPlan.name,
            amount: Number(membership.membershipPlan.price),
            qty: 1,
          },
        ],
        discount: membership.discount ? Number(membership.discount) : 0,
        dueAt: membership.startDate.toISOString(),
      });
      this.logger.log(
        `Auto-raised invoice for membership ${event.membershipId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Auto-invoice for membership ${event.membershipId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // -- aging ---------------------------------------------------------------

  /**
   * Outstanding receivables grouped into age buckets, each bucket a
   * per-currency map -- amounts are never summed across currencies.
   */
  async getAging(organizationId: string, branchScope: string | null = null) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['ISSUED', 'PART_PAID', 'OVERDUE'] },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: {
        dueAt: true,
        grandTotal: true,
        currency: true,
        paymentLinks: {
          select: {
            amount: true,
            payment: { select: { status: true } },
          },
        },
      },
    });
    const now = new Date();
    const buckets: Record<
      'current' | 'd1_7' | 'd8_30' | 'd30plus',
      Record<string, Prisma.Decimal>
    > = {
      current: {},
      d1_7: {},
      d8_30: {},
      d30plus: {},
    };
    for (const invoice of invoices) {
      const outstanding = new Prisma.Decimal(invoice.grandTotal).minus(
        this.paidTotalOf(invoice),
      );
      if (outstanding.lte(0)) continue;
      const daysPast = invoice.dueAt
        ? Math.floor((now.getTime() - invoice.dueAt.getTime()) / MS_PER_DAY)
        : -1;
      const bucket =
        daysPast <= 0
          ? 'current'
          : daysPast <= 7
            ? 'd1_7'
            : daysPast <= 30
              ? 'd8_30'
              : 'd30plus';
      buckets[bucket][invoice.currency] = (
        buckets[bucket][invoice.currency] ?? new Prisma.Decimal(0)
      ).plus(outstanding);
    }
    const render = (bucket: Record<string, Prisma.Decimal>) =>
      Object.fromEntries(
        Object.entries(bucket).map(([currency, total]) => [
          currency,
          total.toFixed(2),
        ]),
      );
    return {
      current: render(buckets.current),
      d1_7: render(buckets.d1_7),
      d8_30: render(buckets.d8_30),
      d30plus: render(buckets.d30plus),
    };
  }

  // -- helpers ---------------------------------------------------------------

  private paidTotalOf(invoice: {
    paymentLinks: { amount: unknown; payment: { status: string } }[];
  }): Prisma.Decimal {
    return invoice.paymentLinks.reduce(
      (sum, link) =>
        link.payment.status !== 'FAILED'
          ? sum.plus(link.amount as Prisma.Decimal)
          : sum,
      new Prisma.Decimal(0),
    );
  }

  /** Outstanding balance of an invoice row carrying its paymentLinks. */
  private outstandingOf(invoice: {
    grandTotal: unknown;
    paymentLinks: { amount: unknown; payment: { status: string } }[];
  }): Prisma.Decimal {
    return new Prisma.Decimal(invoice.grandTotal as Prisma.Decimal).minus(
      this.paidTotalOf(invoice),
    );
  }

  private isPastGrace(dueAt: Date | null, now: Date): boolean {
    if (!dueAt) return false;
    return (
      Math.floor((now.getTime() - dueAt.getTime()) / MS_PER_DAY) >=
      OVERDUE_GRACE_DAYS
    );
  }
}
