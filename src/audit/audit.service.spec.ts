import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

describe('AuditService branch scoping', () => {
  const prisma = {
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const service = new AuditService(prisma as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it('lists org-wide (including org-level rows) when unrestricted', async () => {
    await service.list('org-1', { page: 1, pageSize: 20 } as never);
    const { where } = prisma.auditLog.findMany.mock.calls[0][0];
    expect(where).toEqual({ organizationId: 'org-1' });
    expect(prisma.auditLog.count.mock.calls[0][0].where).toEqual(where);
  });

  it("narrows a branch-scoped caller to their branch's rows only", async () => {
    await service.list('org-1', { page: 1, pageSize: 20 } as never, 'br-a');
    const { where } = prisma.auditLog.findMany.mock.calls[0][0];
    // Equality excludes branchId-null (org-level) rows as well as branch B.
    expect(where).toEqual({ organizationId: 'org-1', branchId: 'br-a' });
    expect(prisma.auditLog.count.mock.calls[0][0].where).toEqual(where);
  });

  it('scopes facets the same way', async () => {
    await service.facets('org-1', 'br-a');
    for (const [args] of prisma.auditLog.groupBy.mock.calls) {
      expect(args.where).toEqual({ organizationId: 'org-1', branchId: 'br-a' });
    }
  });
});
