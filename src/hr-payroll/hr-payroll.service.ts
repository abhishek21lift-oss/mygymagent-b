import {
  BadRequestException,
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
    const branch = dto.branchId
      ? await this.prisma.branch.findFirst({
          where: {
            id: dto.branchId,
            organizationId,
            deletedAt: null,
          },
          select: { id: true },
        })
      : null;

    if (dto.branchId && !branch) {
      throw new BadRequestException(
        'Branch does not belong to this organization',
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
    return this.prisma.leaveRequest.findMany({
      where: {
        organizationId,
        ...(status ? { status: status as any } : {}),
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
        select: { id: true },
      }),
      this.prisma.leaveType.findFirst({
        where: {
          id: dto.leaveTypeId,
          organizationId,
          active: true,
        },
        select: { id: true },
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

    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);

    if (end < start) {
      throw new BadRequestException('endDate must be on or after startDate');
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
        reason: dto.reason,
      },
    });
  }

  async reviewLeave(
    organizationId: string,
    id: string,
    dto: ReviewLeaveDto,
    reviewerId: string,
  ) {
    const existing = await this.prisma.leaveRequest.findFirst({
      where: { id, organizationId, status: 'PENDING' },
    });

    if (!existing) {
      throw new NotFoundException('Pending leave request not found');
    }

    return this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: dto.status,
        reviewedByUserId: reviewerId,
        reviewedAt: new Date(),
        reviewNote: dto.note,
      },
    });
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

    if (end < start) {
      throw new BadRequestException(
        'periodEnd must be on or after periodStart',
      );
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

    const staff = await this.prisma.staffProfile.findMany({
      where: {
        organizationId,
        payrollEnabled: true,
        ...(dto.branchId ? { branchId: dto.branchId } : {}),
      },
      select: { id: true, baseSalary: true, salaryType: true },
    });

    if (staff.length === 0) {
      throw new BadRequestException(
        'No payroll-enabled staff found for this scope',
      );
    }

    const run = await this.prisma.payrollRun.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        createdByUserId: userId,
        periodStart: start,
        periodEnd: end,
        notes: dto.notes,
      },
    });

    const days = Math.max(
      1,
      Math.floor((end.getTime() - start.getTime()) / 86400000) + 1,
    );

    await this.prisma.payrollItem.createMany({
      data: staff.map((s) => {
        const base = s.baseSalary ?? new Prisma.Decimal(0);
        const gross = s.salaryType === 'MONTHLY' ? base : base.mul(days);

        return {
          organizationId,
          payrollRunId: run.id,
          staffProfileId: s.id,
          baseSalary: base,
          gross,
          net: gross,
          payableDays: new Prisma.Decimal(days),
        };
      }),
    });

    return this.prisma.payrollRun.findUnique({
      where: { id: run.id },
      include: { items: true },
    });
  }

  async adjustPayrollItem(
    organizationId: string,
    runId: string,
    dto: PayrollItemAdjustmentDto,
  ) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId, status: 'DRAFT' },
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
    const gross = item.baseSalary.plus(overtime).plus(incentives);
    const net = gross.minus(deductions).minus(item.unpaidLeave);

    return this.prisma.payrollItem.update({
      where: { id: item.id },
      data: {
        overtime,
        incentives,
        deductions,
        gross,
        net,
        notes: dto.notes ?? item.notes,
      },
    });
  }

  async approvePayrollRun(
    organizationId: string,
    runId: string,
    userId: string,
  ) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId, status: 'DRAFT' },
    });

    if (!run) {
      throw new NotFoundException('Draft payroll run not found');
    }

    return this.prisma.payrollRun.update({
      where: { id: runId },
      data: {
        status: 'APPROVED',
        approvedByUserId: userId,
        approvedAt: new Date(),
      },
    });
  }

  async processPayrollRun(organizationId: string, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId, status: 'APPROVED' },
    });

    if (!run) {
      throw new NotFoundException('Approved payroll run not found');
    }

    await this.prisma.payrollItem.updateMany({
      where: { payrollRunId: runId, organizationId },
      data: { status: 'FINALIZED' },
    });

    return this.prisma.payrollRun.update({
      where: { id: runId },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  }
}
