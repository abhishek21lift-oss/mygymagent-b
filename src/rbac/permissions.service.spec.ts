import { PermissionsService } from './permissions.service';

describe('PermissionsService.hasPermission', () => {
  const orgId = 'org-1';
  const userId = 'user-1';

  function buildService(opts: {
    roleGrant: unknown;
    overrides: { effect: 'ALLOW' | 'DENY'; branchId?: string | null }[];
  }) {
    const prisma = {
      userRole: { findFirst: jest.fn().mockResolvedValue(opts.roleGrant) },
      userPermissionOverride: {
        findMany: jest.fn().mockResolvedValue(opts.overrides),
      },
    };
    return { service: new PermissionsService(prisma as never), prisma };
  }

  it('denies when there is no organization context', async () => {
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      overrides: [],
    });
    await expect(
      service.hasPermission(userId, null, 'members.read'),
    ).resolves.toBe(false);
  });

  it('denies when no role grants the permission and there is no override', async () => {
    const { service } = buildService({ roleGrant: null, overrides: [] });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(false);
  });

  it('allows when a role grants the permission', async () => {
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      overrides: [],
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(true);
  });

  it('DENY override wins even when a role would otherwise grant the permission', async () => {
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      overrides: [{ effect: 'DENY' }],
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(false);
  });

  it('ALLOW override grants access even with no role-derived grant', async () => {
    const { service } = buildService({
      roleGrant: null,
      overrides: [{ effect: 'ALLOW' }],
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(true);
  });

  it('DENY always wins, regardless of which row a naive ORDER BY would have returned first (regression for the NULLS-FIRST bug)', async () => {
    // An org-wide ALLOW (branchId: null) and a branch-specific DENY for the
    // same key. The old implementation used `findFirst` ordered by
    // `branchId DESC`, and PostgreSQL's default NULLS FIRST silently
    // returned the org-wide ALLOW row before the branch-specific DENY row
    // -- inverting the documented "DENY always wins" invariant. Order here
    // is deliberately ALLOW-then-DENY to prove the fix doesn't depend on
    // row order either.
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      overrides: [
        { effect: 'ALLOW', branchId: null },
        { effect: 'DENY', branchId: 'branch-A' },
      ],
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read', 'branch-A'),
    ).resolves.toBe(false);
  });

  it('scopes the role-grant lookup to org-wide OR the requested branch, never a different branch', async () => {
    const { service, prisma } = buildService({
      roleGrant: { id: 'ur-1' },
      overrides: [],
    });
    await service.hasPermission(userId, orgId, 'members.read', 'branch-A');

    const where = prisma.userRole.findFirst.mock.calls[0][0].where;
    expect(where.organizationId).toBe(orgId);
    expect(where.OR).toEqual([{ branchId: null }, { branchId: 'branch-A' }]);
  });
});

describe('PermissionsService.getEffectivePermissions', () => {
  const orgId = 'org-1';
  const userId = 'user-1';

  function buildService(opts: {
    roles: {
      role: { rolePermissions: { permission: { key: string } }[] };
    }[];
    overrides: { effect: 'ALLOW' | 'DENY'; permission: { key: string } }[];
  }) {
    const prisma = {
      userRole: { findMany: jest.fn().mockResolvedValue(opts.roles) },
      userPermissionOverride: {
        findMany: jest.fn().mockResolvedValue(opts.overrides),
      },
    };
    return { service: new PermissionsService(prisma as never) };
  }

  it('DENY always wins over ALLOW regardless of row order (matches hasPermission)', async () => {
    const { service } = buildService({
      roles: [],
      overrides: [
        { effect: 'ALLOW', permission: { key: 'members.read' } },
        { effect: 'DENY', permission: { key: 'members.read' } },
      ],
    });
    await expect(
      service.getEffectivePermissions(userId, orgId),
    ).resolves.toEqual([]);
  });

  it('DENY still wins when the DENY row is returned before the ALLOW row', async () => {
    const { service } = buildService({
      roles: [],
      overrides: [
        { effect: 'DENY', permission: { key: 'members.read' } },
        { effect: 'ALLOW', permission: { key: 'members.read' } },
      ],
    });
    await expect(
      service.getEffectivePermissions(userId, orgId),
    ).resolves.toEqual([]);
  });
});
