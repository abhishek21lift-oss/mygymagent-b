import { PermissionsService } from './permissions.service';

describe('PermissionsService.hasPermission', () => {
  const orgId = 'org-1';
  const userId = 'user-1';

  function buildService(opts: {
    roleGrant: unknown;
    override: { effect: 'ALLOW' | 'DENY' } | null;
  }) {
    const prisma = {
      userRole: { findFirst: jest.fn().mockResolvedValue(opts.roleGrant) },
      userPermissionOverride: {
        findFirst: jest.fn().mockResolvedValue(opts.override),
      },
    };
    return { service: new PermissionsService(prisma as never), prisma };
  }

  it('denies when there is no organization context', async () => {
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      override: null,
    });
    await expect(
      service.hasPermission(userId, null, 'members.read'),
    ).resolves.toBe(false);
  });

  it('denies when no role grants the permission and there is no override', async () => {
    const { service } = buildService({ roleGrant: null, override: null });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(false);
  });

  it('allows when a role grants the permission', async () => {
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      override: null,
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(true);
  });

  it('DENY override wins even when a role would otherwise grant the permission', async () => {
    const { service } = buildService({
      roleGrant: { id: 'ur-1' },
      override: { effect: 'DENY' },
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(false);
  });

  it('ALLOW override grants access even with no role-derived grant', async () => {
    const { service } = buildService({
      roleGrant: null,
      override: { effect: 'ALLOW' },
    });
    await expect(
      service.hasPermission(userId, orgId, 'members.read'),
    ).resolves.toBe(true);
  });

  it('scopes the role-grant lookup to org-wide OR the requested branch, never a different branch', async () => {
    const { service, prisma } = buildService({
      roleGrant: { id: 'ur-1' },
      override: null,
    });
    await service.hasPermission(userId, orgId, 'members.read', 'branch-A');

    const where = prisma.userRole.findFirst.mock.calls[0][0].where;
    expect(where.organizationId).toBe(orgId);
    expect(where.OR).toEqual([{ branchId: null }, { branchId: 'branch-A' }]);
  });
});
