import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

function service(prisma: Record<string, unknown>) {
  return new AttendanceService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('AttendanceService QR token branch scoping', () => {
  it.each(['currentQrToken', 'rotateQrToken'] as const)(
    '%s 404s a member whose home branch is not the caller branch',
    async (method) => {
      const prisma = {
        member: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      await expect(
        service(prisma)[method]('o1', 'm1', null, 'br-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.member.findFirst.mock.calls[0][0].where).toEqual({
        id: 'm1',
        organizationId: 'o1',
        deletedAt: null,
        primaryBranchId: 'br-1',
      });
    },
  );

  it('leaves org-wide callers (and the portal) unfiltered', async () => {
    const prisma = {
      member: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      service(prisma).currentQrToken('o1', 'm1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.member.findFirst.mock.calls[0][0].where).toEqual({
      id: 'm1',
      organizationId: 'o1',
      deletedAt: null,
    });
  });
});

describe('AttendanceService device registry branch scoping', () => {
  it('refuses to register a device into another branch', async () => {
    const prisma = { branch: { findFirst: jest.fn() } };
    await expect(
      service(prisma).registerDevice(
        'o1',
        { branchId: 'br-2', name: 'Door' },
        'br-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.branch.findFirst).not.toHaveBeenCalled();
  });

  it('404s revoking a device of another branch', async () => {
    const prisma = {
      kioskDevice: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      service(prisma).revokeDevice('o1', 'd1', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.kioskDevice.findFirst.mock.calls[0][0].where).toEqual({
      id: 'd1',
      organizationId: 'o1',
      branchId: 'br-1',
    });
  });

  it('lists only the caller branch, ignoring a requested other branch', async () => {
    const prisma = {
      kioskDevice: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await service(prisma).listDevices('o1', { branchId: 'br-2' }, 'br-1');
    expect(prisma.kioskDevice.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'o1',
      branchId: 'br-1',
    });
  });
});
