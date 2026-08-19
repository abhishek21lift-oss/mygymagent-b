import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS_CATALOG } from '../src/rbac/permissions.catalog';
import { ROLES_CATALOG } from '../src/rbac/roles.catalog';

const prisma = new PrismaClient();

/**
 * Idempotent: safe to run against a database that already has data.
 * Seeds the global permission catalog and the system-defined roles (both
 * organization-independent, organizationId null) that every tenant gets
 * for free. Organization-specific data (orgs, branches, staff, members) is
 * created through normal application flows (see AuthService.register), not
 * here.
 */
async function main() {
  console.log(`Seeding ${PERMISSIONS_CATALOG.length} permissions...`);
  for (const permission of PERMISSIONS_CATALOG) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
    });
  }

  console.log(`Seeding ${ROLES_CATALOG.length} system roles...`);
  for (const roleDef of ROLES_CATALOG) {
    // Prisma's compound-unique `where` rejects an explicit null, so system
    // roles (organizationId null) are looked up with findFirst instead of
    // upsert's composite selector.
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, key: roleDef.key },
    });
    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: roleDef.name, description: roleDef.description },
        })
      : await prisma.role.create({
          data: {
            key: roleDef.key,
            name: roleDef.name,
            description: roleDef.description,
            isSystem: true,
            organizationId: null,
          },
        });

    const permissions = await prisma.permission.findMany({
      where: { key: { in: roleDef.permissions } },
      select: { id: true },
    });

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    if (permissions.length > 0) {
      await prisma.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      });
    }
  }

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
