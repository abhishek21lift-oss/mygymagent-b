import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { syncCatalogs } from '../src/catalog/catalog-sync';
import { PERMISSIONS_CATALOG } from '../src/rbac/permissions.catalog';
import { ROLES_CATALOG } from '../src/rbac/roles.catalog';
import { DEFAULT_TEMPLATES_CATALOG } from '../src/communications/default-templates.catalog';
import { createTestApp } from './utils/test-app';

/**
 * The catalogs have to end up in the database, and nothing was making
 * sure they did.
 *
 * `prisma/seed.ts` was the only writer, deploy runs `prisma migrate
 * deploy` and nothing else, and `tsx` is a devDependency -- so the seed
 * had not run against production since someone last did it by hand.
 * Production was carrying 59 of 98 permissions and 9 of 24 default
 * templates, and `ORG_OWNER` held 59 grants where the catalog says 98.
 * Every route behind one of the missing 39 answered 403 to everyone,
 * the organization owner included.
 *
 * These cases pin the shape of the fix rather than that one incident:
 * converge from a drifted database, change nothing when there is
 * nothing to change, and do not touch what the catalog does not own.
 */
describe('Catalog sync (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Leave the database as every other suite expects to find it.
    await syncCatalogs(prisma);
    if (app) await app.close().catch(() => {});
  });

  const ownerRole = () =>
    prisma.role.findFirstOrThrow({
      where: { organizationId: null, key: 'ORG_OWNER' },
      select: { id: true },
    });

  it('restores a permission the database is missing, and the grants that went with it', async () => {
    // Exactly the production shape: the key does not exist, so every
    // role that should grant it silently does not.
    await prisma.permission.deleteMany({ where: { key: 'portal.manage' } });
    expect(
      await prisma.permission.count({ where: { key: 'portal.manage' } }),
    ).toBe(0);

    const report = await syncCatalogs(prisma);
    expect(report.permissionsCreated).toBe(1);

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'portal.manage' },
      select: { id: true },
    });
    const owner = await ownerRole();
    const granted = await prisma.rolePermission.count({
      where: { roleId: owner.id, permissionId: permission.id },
    });
    expect(granted).toBe(1);
  });

  it('brings a role back to its full catalog grant list', async () => {
    const owner = await ownerRole();
    const all = await prisma.rolePermission.findMany({
      where: { roleId: owner.id },
      select: { permissionId: true },
    });
    // Strand it the way production was stranded: a role holding a
    // fraction of what the catalog says it holds.
    await prisma.rolePermission.deleteMany({
      where: {
        roleId: owner.id,
        permissionId: { in: all.slice(0, 30).map((g) => g.permissionId) },
      },
    });

    const report = await syncCatalogs(prisma);
    expect(report.grantsAdded).toBe(30);
    expect(
      await prisma.rolePermission.count({ where: { roleId: owner.id } }),
    ).toBe(PERMISSIONS_CATALOG.length);
  });

  it('withdraws a grant the catalog no longer gives a system role', async () => {
    // MEMBER's permission list was emptied when the portal shipped (it
    // used to carry the org-wide reads). A stale row left behind is a
    // live over-grant, so the sync has to take it away.
    const member = await prisma.role.findFirstOrThrow({
      where: { organizationId: null, key: 'MEMBER' },
      select: { id: true },
    });
    const attendanceRead = await prisma.permission.findUniqueOrThrow({
      where: { key: 'attendance.read' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: member.id, permissionId: attendanceRead.id },
    });

    const report = await syncCatalogs(prisma);
    expect(report.grantsRemoved).toBe(1);
    expect(
      await prisma.rolePermission.count({ where: { roleId: member.id } }),
    ).toBe(0);
  });

  it('never deletes a permission the catalog has stopped listing', async () => {
    // Other rows reference permissions. A key retired from the catalog
    // is not a reason to drop grants underneath a running tenant, so
    // this half is additive on purpose.
    const orphan = await prisma.permission.create({
      data: {
        key: 'retired.permission',
        resource: 'retired',
        action: 'permission',
        description: 'Not in the catalog',
      },
      select: { id: true },
    });

    await syncCatalogs(prisma);

    expect(await prisma.permission.count({ where: { id: orphan.id } })).toBe(1);
    await prisma.permission.delete({ where: { id: orphan.id } });
  });

  it('restores a missing default template and repairs a drifted one', async () => {
    await prisma.messageTemplate.deleteMany({
      where: { organizationId: null, key: 'staff_invite', channel: 'EMAIL' },
    });
    const welcome = await prisma.messageTemplate.findFirstOrThrow({
      where: { organizationId: null, key: 'welcome_email', channel: 'EMAIL' },
      select: { id: true, body: true },
    });
    await prisma.messageTemplate.update({
      where: { id: welcome.id },
      data: { body: 'clobbered' },
    });

    const report = await syncCatalogs(prisma);
    expect(report.templatesCreated).toBe(1);
    expect(report.templatesUpdated).toBe(1);

    const repaired = await prisma.messageTemplate.findFirstOrThrow({
      where: { organizationId: null, key: 'welcome_email', channel: 'EMAIL' },
      select: { body: true },
    });
    expect(repaired.body).toBe(welcome.body);
    expect(
      await prisma.messageTemplate.count({ where: { organizationId: null } }),
    ).toBe(DEFAULT_TEMPLATES_CATALOG.length);
  });

  it('leaves an organization-owned role completely alone', async () => {
    // The catalog defines what a *system* role means. An organization
    // that wants something different makes its own, and the sync must
    // not have an opinion about it.
    const org = await prisma.organization.findFirstOrThrow({
      select: { id: true },
    });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'members.read' },
      select: { id: true },
    });
    const custom = await prisma.role.create({
      data: {
        key: 'ORG_OWNER', // same key as a system role, different owner
        name: 'Custom owner',
        description: 'Organization-defined',
        isSystem: false,
        organizationId: org.id,
        rolePermissions: { create: { permissionId: permission.id } },
      },
      select: { id: true },
    });

    await syncCatalogs(prisma);

    const after = await prisma.role.findUniqueOrThrow({
      where: { id: custom.id },
      select: { name: true, _count: { select: { rolePermissions: true } } },
    });
    expect(after.name).toBe('Custom owner');
    expect(after._count.rolePermissions).toBe(1);

    await prisma.role.delete({ where: { id: custom.id } });
  });

  it('changes nothing on a database that is already converged', async () => {
    await syncCatalogs(prisma);
    const report = await syncCatalogs(prisma);
    expect(report).toEqual({
      permissionsCreated: 0,
      permissionsUpdated: 0,
      rolesCreated: 0,
      grantsAdded: 0,
      grantsRemoved: 0,
      templatesCreated: 0,
      templatesUpdated: 0,
    });
  });

  it('serializes concurrent runs instead of duplicating rows', async () => {
    // Two instances of a rollout boot at the same time against one
    // database. Without the advisory lock both read "missing" and both
    // insert.
    await prisma.permission.deleteMany({ where: { key: 'portal.manage' } });

    const reports = await Promise.all([
      syncCatalogs(prisma),
      syncCatalogs(prisma),
      syncCatalogs(prisma),
    ]);

    // Exactly one run creates it; the others wait and find it there.
    expect(reports.filter((r) => r.permissionsCreated === 1)).toHaveLength(1);
    expect(
      await prisma.permission.count({ where: { key: 'portal.manage' } }),
    ).toBe(1);
  });

  it('runs as part of coming up, not only when someone calls it', async () => {
    // This is the actual fix. The sync existing changes nothing if
    // deploy never invokes it -- which was the whole bug, since
    // `prisma/seed.ts` was the only caller and deploy runs
    // `prisma migrate deploy` and stops.
    await prisma.permission.deleteMany({ where: { key: 'portal.manage' } });
    expect(
      await prisma.permission.count({ where: { key: 'portal.manage' } }),
    ).toBe(0);

    const booted = await createTestApp();
    try {
      expect(
        await prisma.permission.count({ where: { key: 'portal.manage' } }),
      ).toBe(1);
    } finally {
      await booted.app.close().catch(() => {});
    }
  });

  it('holds every permission key the role catalog hands out', () => {
    // The sync throws rather than quietly building a smaller role, so a
    // typo here would break every boot. Catch it at test time instead.
    const known = new Set(PERMISSIONS_CATALOG.map((p) => p.key));
    const unknown = ROLES_CATALOG.flatMap((role) =>
      role.permissions.filter((key) => !known.has(key)),
    );
    expect(unknown).toEqual([]);
  });
});
