import 'reflect-metadata';
import { PtPackagesService } from './pt-packages.service';

function pkg() {
  return {
    id: 'pkg-1',
    memberId: 'mem-1',
    totalSessions: 24,
    usedSessions: 16,
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-11-01T00:00:00Z'),
  };
}

describe('PtPackagesService.getWallet', () => {
  it('combines counters, live session states and the consumption ledger', async () => {
    const prisma = {
      ptPackage: {
        findFirst: jest.fn().mockResolvedValue(pkg()),
      },
      ptSession: {
        count: jest
          .fn()
          .mockResolvedValueOnce(2) // scheduled
          .mockResolvedValueOnce(9) // completed
          .mockResolvedValueOnce(1) // cancelled
          .mockResolvedValueOnce(1), // no-show
      },
      ptSessionConsumption: {
        findMany: jest.fn().mockResolvedValue([
          {
            sessions: 1,
            ptSession: {
              id: 's-9',
              startTime: new Date('2026-10-01T10:00:00Z'),
              status: 'COMPLETED',
            },
          },
        ]),
      },
    };
    const service = new PtPackagesService(prisma as never, {} as never);
    const wallet = await service.getWallet('org-1', 'pkg-1', null);
    expect(wallet.totals).toEqual({
      total: 24,
      used: 16,
      remaining: 8,
      scheduled: 2,
      completed: 9,
      cancelled: 1,
      noShow: 1,
    });
    expect(wallet.ledger).toEqual([
      {
        sessionId: 's-9',
        date: '2026-10-01T10:00:00.000Z',
        status: 'COMPLETED',
        sessions: 1,
      },
    ]);
    // Session counts stay inside the package window.
    const window = prisma.ptSession.count.mock.calls[0][0].where.startTime;
    expect(new Date(window.gte).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('404s cross-tenant packages through the same scoped lookup', async () => {
    const prisma = {
      ptPackage: { findFirst: jest.fn().mockResolvedValue(null) },
      ptSession: { count: jest.fn() },
      ptSessionConsumption: { findMany: jest.fn() },
    };
    const service = new PtPackagesService(prisma as never, {} as never);
    await expect(service.getWallet('org-1', 'foreign', null)).rejects.toThrow(
      'PT package not found',
    );
    expect(prisma.ptSession.count).not.toHaveBeenCalled();
  });
});
