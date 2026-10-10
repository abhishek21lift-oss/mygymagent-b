import 'reflect-metadata';
import { FinanceService, type OutstandingScopeCache } from './finance.service';

function membershipRow(price: string, paid: string) {
  return {
    id: `m-${price}-${paid}`,
    status: 'ACTIVE',
    price,
    currency: 'INR',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-12-31'),
    membershipPlan: { name: 'Standard' },
    branch: { id: 'b1', name: 'Main' },
    member: { id: 'mem-1', firstName: 'A', lastName: 'B', phone: null },
    payments: [{ amount: paid, refunds: [] }],
  };
}

function prismaWith(findManyImpl: jest.Mock) {
  return { membership: { findMany: findManyImpl } };
}

describe('FinanceService outstanding request-scoped reuse', () => {
  it('coalesces concurrent same-scope list calls into one query', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([membershipRow('100.00', '40.00')]);
    const service = new FinanceService(prismaWith(findMany) as never);
    const cache: OutstandingScopeCache = new Map();
    const [a, b] = await Promise.all([
      service.listOutstandingMemberships('org-1', null, cache),
      service.listOutstandingMemberships('org-1', null, cache),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a[0].outstanding).toBe('60.00');
  });

  it('isolates by organization and branch', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new FinanceService(prismaWith(findMany) as never);
    const cache: OutstandingScopeCache = new Map();
    await service.listOutstandingMemberships('org-1', null, cache);
    await service.listOutstandingMemberships('org-2', null, cache);
    await service.listOutstandingMemberships('org-1', 'branch-1', cache);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0][0].where.organizationId).toBe('org-1');
    expect(findMany.mock.calls[1][0].where.organizationId).toBe('org-2');
    expect(findMany.mock.calls[2][0].where.branchId).toBe('branch-1');
  });

  it('queries twice without a cache', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new FinanceService(prismaWith(findMany) as never);
    await service.listOutstandingMemberships('org-1', null);
    await service.listOutstandingMemberships('org-1', null);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('drops a rejected query so the next call retries', async () => {
    const findMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([]);
    const service = new FinanceService(prismaWith(findMany) as never);
    const cache: OutstandingScopeCache = new Map();
    await expect(
      service.listOutstandingMemberships('org-1', null, cache),
    ).rejects.toThrow('db down');
    await service.listOutstandingMemberships('org-1', null, cache);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('shares one scan across concurrent getOutstandingBalances calls', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([membershipRow('200.00', '50.00')]);
    const service = new FinanceService(prismaWith(findMany) as never);
    const cache: OutstandingScopeCache = new Map();
    const [a, b] = await Promise.all([
      service.getOutstandingBalances('org-1', null, cache),
      service.getOutstandingBalances('org-1', null, cache),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(a).toEqual([
      {
        currency: 'INR',
        membershipsWithBalance: 1,
        outstandingBalance: '150.00',
      },
    ]);
    expect(b).toEqual(a);
  });
});
