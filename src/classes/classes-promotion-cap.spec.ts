import type { PrismaService } from '../prisma/prisma.service';
import { ClassesService } from './classes.service';

const WEDNESDAY_10AM = new Date('2026-10-14T10:00:00Z'); // ISO week of Mon 12 Oct
const MONDAY_ISO = '2026-10-12T00:00:00.000Z';

/**
 * Waitlist promotion honors weekly caps: an over-cap head is skipped
 * (keeping queue position), the next eligible member is promoted, and
 * members without a cap keep the historical promote-head behavior.
 */
describe('ClassesService promotion weekly cap', () => {
  let prisma: any;
  let service: ClassesService;

  const session = (startTime: Date) => ({ startTime });

  beforeEach(() => {
    prisma = {
      classBooking: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'b-9',
          status: 'BOOKED',
          sessionId: 's-1',
        }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'w-1', memberId: 'm-cap' },
          { id: 'w-2', memberId: 'm-ok' },
        ]),
        count: jest.fn(),
        update: jest.fn(),
      },
      classSession: {
        findFirst: jest.fn().mockResolvedValue(session(WEDNESDAY_10AM)),
      },
      membership: {
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          if (args?.where?.memberId === 'm-free') return null;
          return {
            planSnapshot: { weeklyClassLimit: 1 },
            membershipPlan: { weeklyClassLimit: null },
          };
        }),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: (cb: (tx: any) => unknown) => cb(prisma),
    };
    service = new ClassesService(prisma as unknown as PrismaService);
  });

  const bookedUpdates = () =>
    prisma.classBooking.update.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'BOOKED',
    );

  it('skips the over-cap head and promotes the next eligible member', async () => {
    prisma.classBooking.count
      .mockResolvedValueOnce(1) // m-cap: at cap
      .mockResolvedValueOnce(0); // m-ok: room
    await service.cancel('org-1', 'b-9');
    const promoted = bookedUpdates();
    expect(promoted).toHaveLength(1);
    expect(promoted[0][0].where).toEqual({ id: 'w-2' });
  });

  it('leaves the place empty when nobody on the waitlist is eligible', async () => {
    prisma.classBooking.count.mockResolvedValue(5);
    await service.cancel('org-1', 'b-9');
    expect(bookedUpdates()).toHaveLength(0);
    // The cancelled row is the only update.
    expect(prisma.classBooking.update).toHaveBeenCalledTimes(1);
  });

  it('promotes a member with no cap exactly like before', async () => {
    prisma.classBooking.findMany.mockResolvedValue([
      { id: 'w-1', memberId: 'm-free' },
    ]);
    await service.cancel('org-1', 'b-9');
    const promoted = bookedUpdates();
    expect(promoted).toHaveLength(1);
    expect(promoted[0][0].where).toEqual({ id: 'w-1' });
    expect(prisma.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ memberId: 'm-free' }),
      }),
    );
  });

  it('locks the member-week before counting, on the session week boundary', async () => {
    prisma.classBooking.count.mockResolvedValue(0);
    await service.cancel('org-1', 'b-9');
    const lockCalls = prisma.$executeRaw.mock.calls.map((c: any) =>
      JSON.stringify(c),
    );
    const weekLock = lockCalls.findIndex((s: string) =>
      s.includes(`class-week:m-cap:${MONDAY_ISO}`),
    );
    expect(weekLock).toBeGreaterThanOrEqual(0);
    const countOrder = prisma.classBooking.count.mock.invocationCallOrder[0];
    const lockOrder = prisma.$executeRaw.mock.invocationCallOrder[weekLock];
    expect(lockOrder).toBeLessThan(countOrder);
  });

  it('does not promote when cancelling from the waitlist', async () => {
    prisma.classBooking.findFirst.mockResolvedValue({
      id: 'b-9',
      status: 'WAITLISTED',
      sessionId: 's-1',
    });
    await service.cancel('org-1', 'b-9');
    expect(prisma.classBooking.findMany).not.toHaveBeenCalled();
    expect(bookedUpdates()).toHaveLength(0);
  });
});
