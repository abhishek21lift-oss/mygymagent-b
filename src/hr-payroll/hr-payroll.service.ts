import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreatePayrollRunDto,
  PayrollItemAdjustmentDto,
  ReviewLeaveDto,
} from './dto/hr-payroll.dto';

@Injectable()
export class HrPayrollService {
  constructor(private readonly prisma: PrismaService) {}

  async leaveTypes(organizationId: string) {
    return this.prisma.leaveType.findMany({
      where: { organizationId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createLeaveType(organizationId: string, dto: CreateLeaveTypeDto) {
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

  async leaveRequests(organizationId: string, status?: string) {
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

  async createLeaveRequest(organizationId: string, dto: CreateLeaveRequestDto) {
    const [staff, leaveType, branch] = await Promise.all([
      this.prisma.staffProfile.findFirst({
        where: {
          id: dto.staffProfileId,
          organizationId,
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

    if (dto.unit === 'HALF_DAY' && dto.days > 0.5) {
      throw new BadRequestException(
        'A half-day leave request cannot exceed 0.5 day',
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
        days: new Prisma.Decimal(dto.days),
        reason: dto.reason?.trim() || null,
      },
    });
  }

  async reviewLeave(
    organizationId: string,
    id: string,
    dto: ReviewLeaveDto,
    reviewerId: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.leaveRequest.findFirst({
          where: { id, organizationId, status: 'PENDING' },
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

  async listPayrollRuns(organizationId: string) {
    return this.prisma.payrollRun.findMany({
      where: { organizationId },
      orderBy: { periodStart: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        items: {
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
  ) {
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
                gross = base;
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
  ) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId, status: 'DRAFT' },
      select: { id: true },
    });

    if (!run) {
      throw new NotFoundException('Draft payroll run not found');
    }

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

    let baseGross = item.baseSalary;
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
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const run = await tx.payrollRun.findFirst({
          where: { id: runId, organizationId, status: 'DRAFT' },
          select: { id: true },
        });

        if (!run) {
          throw new NotFoundException('Draft payroll run not found');
        }

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

  async processPayrollRun(organizationId: string, runId: string) {
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

        if (!run) {
          throw new NotFoundException('Approved payroll run not found');
        }

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
              sessionAt: { gte: run.periodStart, lt: run.periodEnd },
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
}
