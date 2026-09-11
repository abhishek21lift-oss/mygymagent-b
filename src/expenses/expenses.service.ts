import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginate } from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateExpenseDto,
  ExpenseSummaryQueryDto,
  ListExpensesQueryDto,
  RejectExpenseDto,
  UpdateExpenseDto,
} from './dto/expense.dto';

/**
 * Gym-side spend tracking (rent, salaries, utilities, marketing,
 * equipment...). Lifecycle: PENDING -> APPROVED -> PAID, with REJECTED
 * as the terminal refusal state. PAID rows are immutable (same ledger
 * discipline as Payment: a correction is a new row, never an edit) --
 * update/delete refuse PAID rows outright.
 *
 * Currency: amounts group per-currency in the summary, never summed
 * across currencies (same rule FinanceService applies to revenue).
 */
@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: ListExpensesQueryDto,
    branchScope: string | null = null,
  ) {
    const where: Prisma.ExpenseWhereInput = {
      organizationId,
      ...(branchScope || query.branchId
        ? { branchId: branchScope ?? query.branchId! }
        : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            expenseDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { expenseDate: query.order ?? 'desc' },
        include: {
          branch: { select: { id: true, name: true } },
          recordedByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
          approvedByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.expense.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const expense = await this.prisma.expense.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: {
        branch: { select: { id: true, name: true } },
        recordedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        approvedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  async create(
    organizationId: string,
    dto: CreateExpenseDto,
    recordedByUserId: string,
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId && dto.branchId !== branchScope)
      throw new BadRequestException(
        'Cannot record an expense outside your assigned branch',
      );
    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: {
          id: dto.branchId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!branch)
        throw new BadRequestException(
          'Branch does not belong to this organization',
        );
    }
    return this.prisma.expense.create({
      data: {
        organizationId,
        branchId: dto.branchId ?? branchScope,
        category: dto.category.trim().toUpperCase(),
        amount: new Prisma.Decimal(dto.amount),
        currency: dto.currency ?? 'USD',
        vendor: dto.vendor,
        billNo: dto.billNo,
        notes: dto.notes,
        expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : new Date(),
        recordedByUserId,
      },
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateExpenseDto,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'PAID')
      throw new BadRequestException(
        'Paid expenses are immutable. Record a new expense to correct them.',
      );
    return this.prisma.expense.update({
      where: { id },
      data: {
        ...(dto.category
          ? { category: dto.category.trim().toUpperCase() }
          : {}),
        ...(dto.amount !== undefined
          ? { amount: new Prisma.Decimal(dto.amount) }
          : {}),
        ...(dto.currency ? { currency: dto.currency } : {}),
        ...(dto.vendor !== undefined ? { vendor: dto.vendor } : {}),
        ...(dto.billNo !== undefined ? { billNo: dto.billNo } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.expenseDate ? { expenseDate: new Date(dto.expenseDate) } : {}),
      },
    });
  }

  async approve(
    organizationId: string,
    id: string,
    approvedByUserId: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'PENDING')
      throw new BadRequestException('Only pending expenses can be approved');
    return this.prisma.expense.update({
      where: { id },
      data: { status: 'APPROVED', approvedByUserId },
    });
  }

  async reject(
    organizationId: string,
    id: string,
    dto: RejectExpenseDto,
    approvedByUserId: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'PENDING')
      throw new BadRequestException('Only pending expenses can be rejected');
    return this.prisma.expense.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approvedByUserId,
        notes: dto.reason
          ? `${existing.notes ? `${existing.notes}\n` : ''}Rejected: ${dto.reason}`
          : existing.notes,
      },
    });
  }

  async markPaid(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'PAID')
      throw new BadRequestException('Expense is already paid');
    if (existing.status === 'REJECTED')
      throw new BadRequestException('Rejected expenses cannot be paid');
    return this.prisma.expense.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });
  }

  async remove(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'PAID')
      throw new BadRequestException(
        'Paid expenses cannot be deleted. They are financial records.',
      );
    await this.prisma.expense.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Spend summary for the finance screens and the expense AI tools:
   * per-currency totals (APPROVED+PAID only -- pending/rejected are not
   * spend yet), per-category breakdown, and counts by status.
   */
  async getSummary(
    organizationId: string,
    query: ExpenseSummaryQueryDto,
    branchScope: string | null = null,
  ) {
    const scoped = {
      organizationId,
      ...(branchScope || query.branchId
        ? { branchId: branchScope ?? query.branchId! }
        : {}),
      ...(query.from || query.to
        ? {
            expenseDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, byStatus] = await Promise.all([
      this.prisma.expense.findMany({
        where: { ...scoped, status: { in: ['APPROVED', 'PAID'] } },
        select: { category: true, amount: true, currency: true },
      }),
      this.prisma.expense.groupBy({
        by: ['status'],
        where: scoped,
        _count: true,
      }),
    ]);

    const byCurrency = new Map<string, Prisma.Decimal>();
    const byCategory = new Map<
      string,
      { total: Prisma.Decimal; count: number }
    >();
    for (const row of rows) {
      byCurrency.set(
        row.currency,
        (byCurrency.get(row.currency) ?? new Prisma.Decimal(0)).plus(
          row.amount,
        ),
      );
      const entry = byCategory.get(row.category) ?? {
        total: new Prisma.Decimal(0),
        count: 0,
      };
      entry.total = entry.total.plus(row.amount);
      entry.count += 1;
      byCategory.set(row.category, entry);
    }

    // Per-category amounts stay grouped by (category, currency) pairs --
    // categories mixing currencies surface as separate rows rather than
    // a summed-across-currencies fiction.
    const categoryCurrency = new Map<
      string,
      {
        category: string;
        currency: string;
        total: Prisma.Decimal;
        count: number;
      }
    >();
    for (const row of rows) {
      const key = `${row.category}::${row.currency}`;
      const entry = categoryCurrency.get(key) ?? {
        category: row.category,
        currency: row.currency,
        total: new Prisma.Decimal(0),
        count: 0,
      };
      entry.total = entry.total.plus(row.amount);
      entry.count += 1;
      categoryCurrency.set(key, entry);
    }

    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      totals: [...byCurrency.entries()].map(([currency, total]) => ({
        currency,
        total: total.toFixed(2),
      })),
      byCategory: [...categoryCurrency.values()]
        .map((entry) => ({
          category: entry.category,
          currency: entry.currency,
          total: entry.total.toFixed(2),
          count: entry.count,
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count,
      })),
    };
  }
}
