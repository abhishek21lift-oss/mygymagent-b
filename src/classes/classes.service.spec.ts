import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ClassesService } from './classes.service';

describe('ClassesService branch scoping', () => {
  const prisma = {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'br-b' }) },
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'm-1' }) },
    classProgram: { findMany: jest.fn().mockResolvedValue([]) },
    classSession: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    classBooking: { findFirst: jest.fn().mockResolvedValue(null) },
    $executeRaw: jest.fn(),
  };
  const service = new ClassesService({
    ...prisma,
    // The transaction client is the same mock.
    $transaction: (cb: (tx: typeof prisma) => unknown) => cb(prisma),
  } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it('overrides a requested branchId with the scope on lists', async () => {
    await service.programs('org-1', { branchId: 'br-b' }, 'br-a');
    expect(prisma.classProgram.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      branchId: 'br-a',
    });
    await service.sessions('org-1', { branchId: 'br-b' }, 'br-a');
    expect(prisma.classSession.findMany.mock.calls[0][0].where.branchId).toBe(
      'br-a',
    );
  });

  it('refuses to create a program or session in another branch', async () => {
    await expect(
      service.createProgram(
        'org-1',
        { branchId: 'br-b', name: 'x', capacity: 1, durationMinutes: 30 },
        'br-a',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createSession(
        'org-1',
        {
          branchId: 'br-b',
          classProgramId: 'p',
          startTime: '2026-01-01T10:00:00Z',
          endTime: '2026-01-01T11:00:00Z',
        },
        'br-a',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.branch.findFirst).not.toHaveBeenCalled();
  });

  it("treats another branch's session or booking as not found", async () => {
    await expect(
      service.book('org-1', 's-1', 'm-1', 'br-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.classSession.findFirst.mock.calls[0][0].where.branchId).toBe(
      'br-a',
    );

    await expect(
      service.sessionBookings('org-1', 's-1', 'br-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.classSession.findFirst.mock.calls[1][0].where.branchId).toBe(
      'br-a',
    );

    await expect(service.cancel('org-1', 'b-1', 'br-a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.attendance('org-1', 'b-1', 'ATTENDED', 'br-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const [args] of prisma.classBooking.findFirst.mock.calls) {
      expect(args.where.branchId).toBe('br-a');
    }
  });
});
