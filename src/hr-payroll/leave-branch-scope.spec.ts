import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { CreateLeaveRequestDto } from './dto/hr-payroll.dto';
import { HrPayrollService } from './hr-payroll.service';

describe('HrPayrollService leave branch scoping', () => {
  const prisma = {
    leaveRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    staffProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    leaveType: { findFirst: jest.fn().mockResolvedValue({ id: 'lt' }) },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'br-a' }) },
  };
  const service = new HrPayrollService({
    ...prisma,
    // The transaction client is the same mock.
    $transaction: (cb: (tx: typeof prisma) => unknown) => cb(prisma),
  } as unknown as PrismaService);
  const dto = (branchId: string) =>
    ({
      staffProfileId: 'sp-1',
      leaveTypeId: 'lt',
      branchId,
      startDate: '2026-01-05',
      endDate: '2026-01-05',
      unit: 'DAY',
    }) as CreateLeaveRequestDto;

  beforeEach(() => jest.clearAllMocks());

  it('lists only staff of the scoped branch', async () => {
    await service.leaveRequests('org-1', undefined, 'br-a');
    expect(prisma.leaveRequest.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      staffProfile: { branchId: 'br-a' },
    });
  });

  it('lists org-wide when unrestricted', async () => {
    await service.leaveRequests('org-1', 'PENDING');
    expect(prisma.leaveRequest.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      status: 'PENDING',
    });
  });

  it('refuses to file leave into another branch', async () => {
    await expect(
      service.createLeaveRequest('org-1', dto('br-b'), 'br-a'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.staffProfile.findFirst).not.toHaveBeenCalled();
  });

  it("looks the staff member up within the caller's branch", async () => {
    await expect(
      service.createLeaveRequest('org-1', dto('br-a'), 'br-a'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.staffProfile.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'sp-1',
      organizationId: 'org-1',
      branchId: 'br-a',
    });
  });

  it("treats another branch's leave as not found on review", async () => {
    await expect(
      service.reviewLeave('org-1', 'lr-1', { status: 'APPROVED' }, 'u', 'br-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.leaveRequest.findFirst.mock.calls[0][0].where).toEqual({
      id: 'lr-1',
      organizationId: 'org-1',
      status: 'PENDING',
      staffProfile: { branchId: 'br-a' },
    });
  });
});
