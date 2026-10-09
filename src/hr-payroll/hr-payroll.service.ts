import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SalaryType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreatePayrollRunDto,
  ListStaffPayrollQueryDto,
  PayrollItemAdjustmentDto,
  ReviewLeaveDto,
  UpdateStaffPayrollDto,
} from './dto/hr-payroll.dto';

/** What a payroll administrator needs to see about a staff member. The
 * user is included because a staff-profile id names nobody. */
const STAFF_PAYROLL_SELECT = {
  id: true,
  userId: true,
  branchId: true,
  employeeCode: true,
  jobTitle: true,
  hireDate: true,
  payrollEnabled: true,
  salaryType: true,
  baseSalary: true,
  hourlyRate: true,
  user: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} as const;

/**
 * The pay settings a payroll run can compute from. A payroll-enabled staff
 * member needs a salary type, and the rate that type pays by: otherwise
 * every payslip in the run is zero.
 */
export function assertPayrollSettings(next: {
  payrollEnabled: boolean;
  salaryType: SalaryType | null;
  baseSalary: Prisma.Decimal | null;
  hourlyRate: Prisma.Decimal | null;
}): void {
  if (!next.payrollEnabled) return;
  if (!next.salaryType) {
    throw new BadRequestException(
      'Set a salaryType (MONTHLY, DAILY or HOURLY) before enabling payroll for this staff member',
    );
  }
  const needsBase =
    next.salaryType === 'MONTHLY' || next.salaryType === 'DAILY';
  if (needsBase && (next.baseSalary === null || next.baseSalary.lte(0))) {
    throw new BadRequestException(
      `A ${next.salaryType} salary needs a baseSalary greater than 0, or every payslip in the run is zero`,
    );
  }
  if (
    next.salaryType === 'HOURLY' &&
    (next.hourlyRate === null || next.hourlyRate.lte(0))
  ) {
    throw new BadRequestException(
      'An HOURLY salary needs an hourlyRate greater than 0, or every payslip in the run is zero',
    );
  }
}

/**
 * The instant after a pay period's last day. The app sends the end as
 * 23:59:59.999 of that day; a bare date (midnight) means the whole day,
 * and `lt periodEnd` left that day's commissions out of every run.
 */
export function endOfPeriod(periodEnd: Date): Date {
  const atMidnight =
    periodEnd.getUTCHours() === 0 &&
    periodEnd.getUTCMinutes() === 0 &&
    periodEnd.getUTCSeconds() === 0 &&
    periodEnd.getUTCMilliseconds() === 0;
  return new Date(periodEnd.getTime() + (atMidnight ? 24 * 60 * 60 * 1000 : 1));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Calendar days from `start` to `end`, both included. */
export function inclusiveDays(start: Date, end: Date): number {
  const day = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((day(end) - day(start)) / MS_PER_DAY) + 1;
}

/**
 * A monthly salary for the days a pay period covers: each month it
 * touches contributes salary x (its days in the period / days in that
 * month). 1-31 January is exactly one salary; 1-15 January is 15/31 of it.
 */
export function monthlyShare(
  salary: Prisma.Decimal,
  start: Date,
  end: Date,
): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const first = Date.UTC(year, month, start.getUTCDate());
  const last = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  while (Date.UTC(year, month, 1) <= last) {
    const monthStart = Date.UTC(year, month, 1);
    const monthEnd = Date.UTC(year, month + 1, 0);
    const from = Math.max(first, monthStart);
    const to = Math.min(last, monthEnd);
    if (to >= from) {
      const covered = (to - from) / MS_PER_DAY + 1;
      const inMonth = (monthEnd - monthStart) / MS_PER_DAY + 1;
      total = total.plus(salary.mul(covered).div(inMonth));
    }
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return total.toDecimalPlaces(2);
}

/**
 * Gate for mutating a payroll run. Missing, or another branch's run for a
 * branch-scoped caller, is the same 404 (no existence oracle). An
 * organization-wide run (branchId null) is visible to a branch-scoped
 * caller in the list, so refusing it is an honest 403: approving or
 * paying it would act on every branch's staff, not just theirs.
 */
function assertRunInScope<T extends { branchId: string | null }>(
  run: T | null,
  branchScope: string | null,
  notFoundMessage: string,
): asserts run is T {
  if (!run || (branchScope && run.branchId && run.branchId !== branchScope)) {
    throw new NotFoundException(notFoundMessage);
  }
  if (branchScope && run.branchId === null) {
    throw new ForbiddenException(
      'This payroll run covers the whole organization; only an organization-wide role can change it',
    );
  }
}

@Injectable()
export class HrPayrollService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A branch-scoped caller sees the organization-wide types (branchId
   * null, which apply to every branch) plus their own branch's.
   */
  async leaveTypes(organizationId: string, branchScope: string | null = null) {
    return this.prisma.leaveType.findMany({
      where: {
        organizationId,
        active: true,
        ...(branchScope
          ? { OR: [{ branchId: null }, { branchId: branchScope }] }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  /** A branch-scoped caller may only define types for their own branch;
   * an organization-wide type would apply to every other branch too. */
  async createLeaveType(
    organizationId: string,
    dto: CreateLeaveTypeDto,
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot create a leave type outside your assigned branch',
      );
    }
    const code = dto.code.trim().toUpperCase();
    if (!code || !dto.name.trim()) {
      throw new BadRequestException('Leave type name and code are required');
    }

    const branch = dto.branchId
      ? await this.prisma.branch.findFirst({
          where: { id: dto.branchId, organizationId, deletedAt: null },
          select: { id: true },
        })
      : null;

    if (dto.branchId && !branch) {
      throw new BadRequestException(
        'Branch does not belong to this organization',
      );
    }

    const duplicate = await this.prisma.leaveType.findFirst({
      where: {
        organizationId,
        code,
        ...(dto.branchId ? { branchId: dto.branchId } : { branchId: null }),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        'Leave type code already exists in this scope',
      );
    }

    return this.prisma.leaveType.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        name: dto.name.trim(),
        code,
        paid: dto.paid ?? true,
        annualQuota: new Prisma.Decimal(dto.annualQuota ?? 0),
        carryForward: dto.carryForward ?? false,
      },
    });
  }

  /**
   * Leave belongs to a staff member, and a staff member belongs to the
   * branch on their StaffProfile -- the same mapping `listStaffPayroll`
   * scopes by. A branch-scoped caller sees only their branch's staff;
   * staff with no branch (org-level) are outside every one-branch grant.
   */
  async leaveRequests(
    organizationId: string,
    status?: string,
    branchScope: string | null = null,
  ) {
    const allowedStatuses = [
      'PENDING',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ] as const;
    if (
      status &&
      !allowedStatuses.includes(status as (typeof allowedStatuses)[number])
    ) {
      throw new BadRequestException('Invalid leave request status');
    }

    return this.prisma.leaveRequest.findMany({
      where: {
        organizationId,
        ...(branchScope ? { staffProfile: { branchId: branchScope } } : {}),
        ...(status
          ? { status: status as (typeof allowedStatuses)[number] }
          : {}),
      },
      orderBy: { startDate: 'desc' },
      include: {
        staffProfile: {
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
        leaveType: true,
        branch: { select: { id: true, name: true } },
      },
    });
  }

  async createLeaveRequest(
    organizationId: string,
    dto: CreateLeaveRequestDto,
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot file leave outside your assigned branch',
      );
    }
    const [staff, leaveType, branch] = await Promise.all([
      this.prisma.staffProfile.findFirst({
        where: {
          id: dto.staffProfileId,
          organizationId,
          // Another branch's staff (or an org-level one) reads as not in
          // this organization to a branch-scoped caller, as everywhere else.
          ...(branchScope ? { branchId: branchScope } : {}),
          user: { deletedAt: null },
        },
        select: { id: true, branchId: true },
      }),
      this.prisma.leaveType.findFirst({
        where: { id: dto.leaveTypeId, organizationId, active: true },
        select: { id: true, branchId: true },
      }),
      this.prisma.branch.findFirst({
        where: {
          id: dto.branchId,
          organizationId,
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    if (!staff || !leaveType || !branch) {
      throw new BadRequestException(
        'Staff, leave type, and branch must belong to this organization',
      );
    }

    if (staff.branchId && staff.branchId !== dto.branchId) {
      throw new BadRequestException(
        'Leave branch must match the staff member branch',
      );
    }

    if (leaveType.branchId && leaveType.branchId !== dto.branchId) {
      throw new BadRequestException(
        'Leave type is not available for this branch',
      );
    }

    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      throw new BadRequestException('Invalid leave date range');
    }

    // Days come from the dates. A request used to state its own count, so
    // ten days off could be booked -- and taken from the balance -- as one.
    const calendarDays = inclusiveDays(start, end);
    if (dto.unit === 'HALF_DAY' && calendarDays !== 1) {
      throw new BadRequestException('A half-day leave is on a single day');
    }
    const days = dto.unit === 'HALF_DAY' ? 0.5 : (dto.days ?? calendarDays);
    if (dto.unit === 'HALF_DAY' && dto.days !== undefined && dto.days !== 0.5) {
      throw new BadRequestException('A half-day leave is 0.5 day');
    }
    if (days > calendarDays) {
      throw new BadRequestException(
        `${days} days is more than the ${calendarDays} days from ${dto.startDate.slice(0, 10)} to ${dto.endDate.slice(0, 10)}`,
      );
    }

    const overlapping = await this.prisma.leaveRequest.findFirst({
      where: {
        organizationId,
        staffProfileId: dto.staffProfileId,
        status: 'APPROVED',
        startDate: { lte: end },
        endDate: { gte: start },
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new ConflictException(
        'An approved leave already overlaps this date range',
      );
    }

    return this.prisma.leaveRequest.create({
      data: {
        organizationId,
        staffProfileId: dto.staffProfileId,
        leaveTypeId: dto.leaveTypeId,
        branchId: dto.branchId,
        startDate: start,
        endDate: end,
        unit: dto.unit,
        days: new Prisma.Decimal(days),
        reason: dto.reason?.trim() || null,
      },
    });
  }

  async reviewLeave(
    organizationId: string,
    id: string,
    dto: ReviewLeaveDto,
    reviewerId: string,
    branchScope: string | null = null,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.leaveRequest.findFirst({
          where: {
            id,
            organizationId,
            status: 'PENDING',
            // Scoped like `leaveRequests`: out-of-branch reads as not found.
            ...(branchScope ? { staffProfile: { branchId: branchScope } } : {}),
          },
          include: {
            leaveType: true,
            staffProfile: { select: { id: true } },
          },
        });

        if (!existing) {
          throw new NotFoundException('Pending leave request not found');
        }

        if (dto.status === 'APPROVED' && existing.leaveType.paid) {
          const year = existing.startDate.getUTCFullYear();
          const requestedDays = new Prisma.Decimal(existing.days);

          const balance = await tx.leaveBalance.upsert({
            where: {
              staffProfileId_leaveTypeId_year: {
                staffProfileId: existing.staffProfileId,
                leaveTypeId: existing.leaveTypeId,
                year,
              },
            },
            create: {
              organizationId,
              staffProfileId: existing.staffProfileId,
              leaveTypeId: existing.leaveTypeId,
              year,
              accrued: existing.leaveType.annualQuota,
              closing: existing.leaveType.annualQuota,
            },
            update: {},
          });

          const available = balance.opening
            .plus(balance.accrued)
            .plus(balance.adjustment)
            .minus(balance.used);

          if (requestedDays.greaterThan(available)) {
            throw new BadRequestException(
              `Insufficient leave balance. Available: ${available.toFixed(2)}`,
            );
          }

          const used = balance.used.plus(requestedDays);
          const closing = balance.opening
            .plus(balance.accrued)
            .plus(balance.adjustment)
            .minus(used);

          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: { used, closing },
          });
        }

        return tx.leaveRequest.update({
          where: { id: existing.id },
          data: {
            status: dto.status,
            reviewedByUserId: reviewerId,
            reviewedAt: new Date(),
            reviewNote: dto.note?.trim() || null,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  /**
   * Branch scoping for payroll. A run either belongs to one branch
   * (`PayrollRun.branchId`) or covers the whole organization (null). A
   * branch-scoped caller sees their branch's runs in full, and
   * organization-wide runs with only the lines for their branch's staff
   * (by `StaffProfile.branchId`, as leave is scoped) -- never colleagues'
   * pay at other branches. Other branches' runs are invisible.
   */
  async listPayrollRuns(
    organizationId: string,
    branchScope: string | null = null,
  ) {
    return this.prisma.payrollRun.findMany({
      where: {
        organizationId,
        ...(branchScope
          ? { OR: [{ branchId: branchScope }, { branchId: null }] }
          : {}),
      },
      orderBy: { periodStart: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        items: {
          ...(branchScope
            ? {
                where: {
                  OR: [
                    { payrollRun: { branchId: branchScope } },
                    { staffProfile: { branchId: branchScope } },
                  ],
                },
              }
            : {}),
          include: {
            staffProfile: {
              include: {
                user: {
                  select: { id: true, firstName: true, lastName: true },
                },
              },
            },
          },
        },
      },
    });
  }

  async createPayrollRun(
    organizationId: string,
    userId: string,
    dto: CreatePayrollRunDto,
    branchScope: string | null = null,
  ) {
    // An organization-wide run (no branchId) pays every branch's staff.
    if (branchScope && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot create a payroll run outside your assigned branch',
      );
    }
    const start = new Date(dto.periodStart);
    const end = new Date(dto.periodEnd);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      throw new BadRequestException('Invalid payroll period');
    }

    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: {
          id: dto.branchId,
          organizationId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!branch) {
        throw new BadRequestException(
          'Branch does not belong to this organization',
        );
      }
    }

    const days = Math.max(
      1,
      Math.floor((end.getTime() - start.getTime()) / 86400000) + 1,
    );

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const staff = await tx.staffProfile.findMany({
            where: {
              organizationId,
              payrollEnabled: true,
              ...(dto.branchId ? { branchId: dto.branchId } : {}),
            },
            select: {
              id: true,
              baseSalary: true,
              hourlyRate: true,
              salaryType: true,
            },
          });

          if (staff.length === 0) {
            throw new BadRequestException(
              'No payroll-enabled staff found for this scope',
            );
          }

          // Nobody is paid twice for a day. The unique index cannot catch
          // this: it misses organisation-wide runs (a NULL branch never
          // equals another NULL in Postgres) and any period that overlaps
          // without matching exactly. An organisation-wide run covers
          // every branch, so it clashes with any run in the window.
          const clash = await tx.payrollRun.findFirst({
            where: {
              organizationId,
              status: { not: 'CANCELLED' },
              periodStart: { lte: end },
              periodEnd: { gte: start },
              ...(dto.branchId
                ? { OR: [{ branchId: dto.branchId }, { branchId: null }] }
                : {}),
            },
            select: { periodStart: true, periodEnd: true },
          });
          if (clash) {
            throw new ConflictException(
              `A payroll run already covers ${clash.periodStart
                .toISOString()
                .slice(0, 10)} to ${clash.periodEnd
                .toISOString()
                .slice(0, 10)} for this scope`,
            );
          }

          const run = await tx.payrollRun.create({
            data: {
              organizationId,
              branchId: dto.branchId,
              createdByUserId: userId,
              periodStart: start,
              periodEnd: end,
              notes: dto.notes?.trim() || null,
            },
          });

          await tx.payrollItem.createMany({
            data: staff.map((s) => {
              const base = s.baseSalary ?? new Prisma.Decimal(0);
              const hourlyRate = s.hourlyRate ?? new Prisma.Decimal(0);

              let gross = new Prisma.Decimal(0);
              if (s.salaryType === 'MONTHLY') {
                // A monthly salary for the part of each month the run
                // covers; a whole calendar month is the full salary. A
                // fortnight's run used to pay the full month.
                gross = monthlyShare(base, start, end);
              } else if (s.salaryType === 'DAILY') {
                gross = base.mul(days);
              }

              return {
                organizationId,
                payrollRunId: run.id,
                staffProfileId: s.id,
                baseSalary: s.salaryType === 'HOURLY' ? hourlyRate : base,
                gross,
                net: gross,
                payableDays: new Prisma.Decimal(days),
                metadata: {
                  salaryType: s.salaryType,
                  hourlyRate: hourlyRate.toFixed(2),
                },
              };
            }),
          });

          return tx.payrollRun.findUnique({
            where: { id: run.id },
            include: { items: true },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A payroll run already exists for this organization, branch, and period',
        );
      }
      throw error;
    }
  }

  async adjustPayrollItem(
    organizationId: string,
    runId: string,
    dto: PayrollItemAdjustmentDto,
    branchScope: string | null = null,
  ) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId, status: 'DRAFT' },
      select: { id: true, branchId: true, periodStart: true, periodEnd: true },
    });

    assertRunInScope(run, branchScope, 'Draft payroll run not found');

    const item = await this.prisma.payrollItem.findFirst({
      where: {
        payrollRunId: runId,
        staffProfileId: dto.staffProfileId,
        organizationId,
      },
    });

    if (!item) {
      throw new NotFoundException('Payroll item not found');
    }

    const overtime = new Prisma.Decimal(dto.overtime ?? item.overtime);
    const incentives = new Prisma.Decimal(dto.incentives ?? item.incentives);
    const deductions = new Prisma.Decimal(dto.deductions ?? item.deductions);
    const unpaidLeave = new Prisma.Decimal(dto.unpaidLeave ?? item.unpaidLeave);
    const regularHours = new Prisma.Decimal(
      dto.regularHours ?? item.regularHours,
    );

    const metadata =
      item.metadata &&
      typeof item.metadata === 'object' &&
      !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : {};
    const salaryType = metadata.salaryType;
    const hourlyRate = new Prisma.Decimal(
      typeof metadata.hourlyRate === 'string' ||
        typeof metadata.hourlyRate === 'number'
        ? metadata.hourlyRate
        : 0,
    );

    // The run's share of a monthly salary, as when the run was made --
    // an adjustment used to reset it to the full month.
    let baseGross =
      salaryType === 'MONTHLY'
        ? monthlyShare(item.baseSalary, run.periodStart, run.periodEnd)
        : item.baseSalary;
    if (salaryType === 'HOURLY') {
      if (regularHours.isZero()) {
        throw new BadRequestException(
          'Regular hours are required for hourly payroll',
        );
      }
      baseGross = hourlyRate.mul(regularHours);
    } else if (salaryType === 'DAILY') {
      baseGross = item.baseSalary.mul(item.payableDays);
    }

    const gross = baseGross.plus(overtime).plus(incentives);
    const net = gross.minus(deductions).minus(unpaidLeave);

    return this.prisma.payrollItem.update({
      where: { id: item.id },
      data: {
        overtime,
        incentives,
        deductions,
        unpaidLeave,
        regularHours,
        gross,
        net,
        notes: dto.notes?.trim() ?? item.notes,
      },
    });
  }

  async approvePayrollRun(
    organizationId: string,
    runId: string,
    userId: string,
    branchScope: string | null = null,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const run = await tx.payrollRun.findFirst({
          where: { id: runId, organizationId, status: 'DRAFT' },
          select: { id: true, branchId: true },
        });

        assertRunInScope(run, branchScope, 'Draft payroll run not found');

        const itemCount = await tx.payrollItem.count({
          where: { payrollRunId: runId, organizationId },
        });
        if (itemCount === 0) {
          throw new BadRequestException(
            'Cannot approve a payroll run without payroll items',
          );
        }

        return tx.payrollRun.update({
          where: { id: runId },
          data: {
            status: 'APPROVED',
            approvedByUserId: userId,
            approvedAt: new Date(),
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  async processPayrollRun(
    organizationId: string,
    runId: string,
    branchScope: string | null = null,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const run = await tx.payrollRun.findFirst({
          where: { id: runId, organizationId, status: 'APPROVED' },
          select: {
            id: true,
            branchId: true,
            periodStart: true,
            periodEnd: true,
          },
        });

        assertRunInScope(run, branchScope, 'Approved payroll run not found');

        const result = await tx.payrollItem.updateMany({
          where: {
            payrollRunId: runId,
            organizationId,
            status: { not: 'FINALIZED' },
          },
          data: { status: 'FINALIZED' },
        });

        if (result.count === 0) {
          throw new BadRequestException(
            'Payroll run has no finalizable payroll items',
          );
        }

        // Trainer commissions earned inside this window are approved here
        // too (B-P0-6). They used to hang off a second pay-cycle object,
        // `PayrollPeriod`, which modelled the same thing -- a window with
        // a status -- but knew nothing about branches, approvers or items.
        // Paying staff and approving the commissions they earned in the
        // same window are one act, and now happen in one transaction.
        //
        // A branch-scoped run must only approve its own branch's
        // commissions. `TrainerCommission` carries no branch, so the
        // trainer's staff profile supplies it; an organization-wide run
        // (branchId null) approves them all.
        const branchTrainerIds = run.branchId
          ? (
              await tx.staffProfile.findMany({
                where: { branchId: run.branchId },
                select: { id: true },
              })
            ).map((p) => p.id)
          : null;

        if (branchTrainerIds === null || branchTrainerIds.length > 0) {
          await tx.trainerCommission.updateMany({
            where: {
              organizationId,
              status: 'PENDING',
              sessionAt: {
                gte: run.periodStart,
                lt: endOfPeriod(run.periodEnd),
              },
              ...(branchTrainerIds
                ? { trainerId: { in: branchTrainerIds } }
                : {}),
            },
            data: { status: 'APPROVED' },
          });
        }

        return tx.payrollRun.update({
          where: { id: runId },
          data: { status: 'PROCESSED', processedAt: new Date() },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  /**
   * Who is on payroll, and on what terms (B-P1-7).
   *
   * Keyed by `userId` rather than staff-profile id, because that is what
   * the staff screen and every other user-facing route already hold; the
   * profile id is an implementation detail of the HR tables.
   */
  async listStaffPayroll(
    organizationId: string,
    query: ListStaffPayrollQueryDto = {},
    branchScope: string | null = null,
  ) {
    const branchId = branchScope ?? query.branchId;
    const items = await this.prisma.staffProfile.findMany({
      where: {
        organizationId,
        ...(branchId ? { branchId } : {}),
        ...(query.payrollEnabledOnly ? { payrollEnabled: true } : {}),
        user: { deletedAt: null },
      },
      select: STAFF_PAYROLL_SELECT,
      orderBy: { user: { firstName: 'asc' } },
    });
    return { items };
  }

  /**
   * Sets a staff member's payroll terms.
   *
   * The validation here is the substance of B-P1-7, not the write. The
   * fields could have been bolted onto `PATCH /users/:id` in a line, but
   * `processPayrollRun` multiplies `baseSalary` for MONTHLY and DAILY and
   * falls back to `Decimal(0)` when it is null -- so marking someone
   * payroll-enabled without a salary type, or a DAILY rate without an
   * amount, produces a run full of zero-rupee payslips and no complaint
   * from anywhere. An incoherent combination has to be impossible to
   * save, or the endpoint just moves the silent failure one step later.
   *
   * It validates the *resulting* row, not the patch: sending only
   * `{payrollEnabled: true}` is fine when a salary type is already
   * stored, and refused when it is not.
   */
  async updateStaffPayroll(
    organizationId: string,
    userId: string,
    dto: UpdateStaffPayrollDto,
    branchScope: string | null = null,
  ) {
    const profile = await this.prisma.staffProfile.findFirst({
      where: {
        userId,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        user: { deletedAt: null },
      },
      select: {
        id: true,
        payrollEnabled: true,
        salaryType: true,
        baseSalary: true,
        hourlyRate: true,
      },
    });
    if (!profile) throw new NotFoundException('Staff member not found');

    // The row as it would be after this patch.
    const next = {
      payrollEnabled: dto.payrollEnabled ?? profile.payrollEnabled,
      salaryType: dto.salaryType ?? profile.salaryType,
      baseSalary:
        dto.baseSalary !== undefined
          ? new Prisma.Decimal(dto.baseSalary)
          : profile.baseSalary,
      hourlyRate:
        dto.hourlyRate !== undefined
          ? new Prisma.Decimal(dto.hourlyRate)
          : profile.hourlyRate,
    };

    assertPayrollSettings(next);

    return this.prisma.staffProfile.update({
      where: { id: profile.id },
      data: {
        ...(dto.payrollEnabled !== undefined
          ? { payrollEnabled: dto.payrollEnabled }
          : {}),
        ...(dto.salaryType !== undefined ? { salaryType: dto.salaryType } : {}),
        ...(dto.baseSalary !== undefined ? { baseSalary: dto.baseSalary } : {}),
        ...(dto.hourlyRate !== undefined ? { hourlyRate: dto.hourlyRate } : {}),
        ...(dto.employeeCode !== undefined
          ? { employeeCode: dto.employeeCode.trim() || null }
          : {}),
        ...(dto.hireDate !== undefined
          ? { hireDate: new Date(dto.hireDate) }
          : {}),
      },
      select: STAFF_PAYROLL_SELECT,
    });
  }
}
