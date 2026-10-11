import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ClassesService } from './classes.service';

const MONDAY_10AM = new Date('2026-10-12T10:00:00Z'); // a Monday
const WEDNESDAY_10AM = new Date('2026-10-14T10:00:00Z'); // same ISO week

/**
 * Weekly class-limit enforcement. Prisma is mocked; the transaction
 * client is the same mock so ordering is observable.
 */
describe('ClassesService weekly class limit', () => {
  let prisma: any;
  let service: ClassesService;

  const session = {
    id: 's-1',
    branchId: 'b-1',
    capacity: 20,
    startTime: WEDNESDAY_10AM,
    endTime: new Date('2026-10-14T11:00:00Z'),
    classProgram: { capacity: 20 },
  };

  // Membership covering Wednesday with a 2-class weekly cap.
  const covering = {
    planSnapshot: { weeklyClassLimit: 2 },
    membershipPlan: { weeklyClassLimit: null },
  };

  beforeEach(() => {
    prisma = {
      member: { findFirst: jest.fn().mockResolvedValue({ id: 'm-1' }) },
      classSession: { findFirst: jest.fn().mockResolvedValue(session) },
      classBooking: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn(),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'bk-1',
          ...data,
        })),
        update: jest.fn().mockImplementation(async ({ data }: any) => data),
      },
      membership: { findFirst: jest.fn().mockResolvedValue(covering) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: (cb: (tx: any) => unknown) => cb(prisma),
    };
    service = new ClassesService(prisma as unknown as PrismaService);
    jest.spyOn(Date, 'now').mockReturnValue(MONDAY_10AM.getTime());
  });

  afterEach(() => jest.restoreAllMocks());

  it('allows booking under the weekly cap', async () => {
    prisma.classBooking.count.mockResolvedValueOnce(1).mockResolvedValueOnce(5);
    const booking = await service.book('org-1', 's-1', 'm-1');
    expect(booking).toMatchObject({ status: 'BOOKED' });
  });

  it('rejects booking at the weekly cap', async () => {
    prisma.classBooking.count.mockResolvedValueOnce(2);
    await expect(service.book('org-1', 's-1', 'm-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('counts only the session week and BOOKED places', async () => {
    prisma.classBooking.count.mockResolvedValueOnce(0).mockResolvedValueOnce(8);
    await service.book('org-1', 's-1', 'm-1');
    const weekCall = prisma.classBooking.count.mock.calls[0][0];
    expect(weekCall.where).toMatchObject({
      memberId: 'm-1',
      status: 'BOOKED',
    });
    expect(weekCall.where.session.startTime.gte.toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
  });

  it('skips enforcement with no covering membership or no cap', async () => {
    prisma.membership.findFirst.mockResolvedValueOnce(null);
    prisma.classBooking.count.mockResolvedValueOnce(3);
    await service.book('org-1', 's-1', 'm-1');
    // Only the capacity count ran, not the weekly count.
    expect(prisma.classBooking.count).toHaveBeenCalledTimes(1);

    prisma.classBooking.count.mockClear();
    prisma.membership.findFirst.mockResolvedValueOnce({
      planSnapshot: {},
      membershipPlan: { weeklyClassLimit: null },
    });
    prisma.classBooking.count.mockResolvedValueOnce(3);
    await service.book('org-1', 's-1', 'm-1');
    // Again only the capacity count: no cap, no weekly count.
    expect(prisma.classBooking.count).toHaveBeenCalledTimes(1);
  });
});
