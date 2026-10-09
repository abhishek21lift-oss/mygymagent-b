import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  CreateLeaveTypeDto,
  CreatePayrollRunDto,
} from './dto/hr-payroll.dto';
import { HrPayrollService } from './hr-payroll.service';

describe('HrPayrollService leave-type and payroll branch scoping', () => {
  const prisma = {
    leaveType: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'lt' }),
    },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'br-a' }) },
    payrollRun: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'run' }),
    },
    payrollItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    staffProfile: { findMany: jest.fn().mockResolvedValue([]) },
    trainerCommission: { updateMany: jest.fn() },
  };
  const service = new HrPayrollService({
    ...prisma,
    $transaction: (cb: (tx: typeof prisma) => unknown) => cb(prisma),
  } as unknown as PrismaService);

  const leaveTypeDto = (branchId?: string) =>
    ({ name: 'Sick', code: 'sl', branchId }) as CreateLeaveTypeDto;
  const runDto = (branchId?: string) =>
    ({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      branchId,
    }) as CreatePayrollRunDto;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.payrollRun.findFirst.mockResolvedValue(null);
  });

  describe('leave types', () => {
    it('lists org-wide types plus the scoped branch', async () => {
      await service.leaveTypes('org-1', 'br-a');
      expect(prisma.leaveType.findMany.mock.calls[0][0].where).toEqual({
        organizationId: 'org-1',
        active: true,
        OR: [{ branchId: null }, { branchId: 'br-a' }],
      });
    });

    it('lists everything when unrestricted', async () => {
      await service.leaveTypes('org-1');
      expect(prisma.leaveType.findMany.mock.calls[0][0].where).toEqual({
        organizationId: 'org-1',
        active: true,
      });
    });

    it.each([
      ['another branch', 'br-b'],
      ['organization-wide', undefined],
    ])('refuses to create a %s type', async (_label, branchId) => {
      await expect(
        service.createLeaveType('org-1', leaveTypeDto(branchId), 'br-a'),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot create a leave type outside your assigned branch',
        ),
      );
      expect(prisma.leaveType.create).not.toHaveBeenCalled();
    });

    it('creates a type for the caller’s own branch', async () => {
      await service.createLeaveType('org-1', leaveTypeDto('br-a'), 'br-a');
      expect(prisma.leaveType.create.mock.calls[0][0].data).toMatchObject({
        organizationId: 'org-1',
        branchId: 'br-a',
        code: 'SL',
      });
    });

    it('lets an unrestricted caller create an org-wide type', async () => {
      await service.createLeaveType('org-1', leaveTypeDto());
      expect(prisma.leaveType.create).toHaveBeenCalled();
    });
  });

  describe('payroll runs', () => {
    it('lists own-branch and org-wide runs, with lines filtered to the branch', async () => {
      await service.listPayrollRuns('org-1', 'br-a');
      const args = prisma.payrollRun.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        organizationId: 'org-1',
        OR: [{ branchId: 'br-a' }, { branchId: null }],
      });
      expect(args.include.items.where).toEqual({
        OR: [
          { payrollRun: { branchId: 'br-a' } },
          { staffProfile: { branchId: 'br-a' } },
        ],
      });
    });

    it('lists every run and line when unrestricted', async () => {
      await service.listPayrollRuns('org-1');
      const args = prisma.payrollRun.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ organizationId: 'org-1' });
      expect(args.include.items.where).toBeUndefined();
    });

    it.each([
      ['another branch', 'br-b'],
      ['organization-wide', undefined],
    ])('refuses to create a %s run', async (_label, branchId) => {
      await expect(
        service.createPayrollRun('org-1', 'u', runDto(branchId), 'br-a'),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot create a payroll run outside your assigned branch',
        ),
      );
      expect(prisma.branch.findFirst).not.toHaveBeenCalled();
    });

    const mutations: [string, () => Promise<unknown>][] = [
      [
        'adjust',
        () =>
          service.adjustPayrollItem(
            'org-1',
            'run-1',
            { staffProfileId: 'sp-1' } as never,
            'br-a',
          ),
      ],
      [
        'approve',
        () => service.approvePayrollRun('org-1', 'run-1', 'u', 'br-a'),
      ],
      ['process', () => service.processPayrollRun('org-1', 'run-1', 'br-a')],
    ];

    it.each(mutations)(
      '%s: another branch’s run is 404',
      async (_label, call) => {
        prisma.payrollRun.findFirst.mockResolvedValue({
          id: 'run-1',
          branchId: 'br-b',
          periodStart: new Date('2026-01-01'),
          periodEnd: new Date('2026-01-31'),
        });
        await expect(call()).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.payrollItem.updateMany).not.toHaveBeenCalled();
        expect(prisma.payrollRun.update).not.toHaveBeenCalled();
      },
    );

    it.each(mutations)(
      '%s: an organization-wide run is 403',
      async (_label, call) => {
        prisma.payrollRun.findFirst.mockResolvedValue({
          id: 'run-1',
          branchId: null,
          periodStart: new Date('2026-01-01'),
          periodEnd: new Date('2026-01-31'),
        });
        await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.payrollItem.updateMany).not.toHaveBeenCalled();
        expect(prisma.payrollRun.update).not.toHaveBeenCalled();
      },
    );

    it('approves the caller’s own branch run', async () => {
      prisma.payrollRun.findFirst.mockResolvedValue({
        id: 'run-1',
        branchId: 'br-a',
      });
      await service.approvePayrollRun('org-1', 'run-1', 'u', 'br-a');
      expect(prisma.payrollRun.update).toHaveBeenCalled();
    });

    it('lets an unrestricted caller approve an org-wide run', async () => {
      prisma.payrollRun.findFirst.mockResolvedValue({
        id: 'run-1',
        branchId: null,
      });
      await service.approvePayrollRun('org-1', 'run-1', 'u');
      expect(prisma.payrollRun.update).toHaveBeenCalled();
    });
  });
});
