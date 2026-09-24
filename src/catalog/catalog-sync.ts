import type { PrismaClient } from '@prisma/client';
import { DEFAULT_TEMPLATES_CATALOG } from '../communications/default-templates.catalog';
import { PERMISSIONS_CATALOG } from '../rbac/permissions.catalog';
import { ROLES_CATALOG } from '../rbac/roles.catalog';

/**
 * Brings the three code-owned catalogs -- permissions, system roles and
 * system-default message templates -- into the database.
 *
 * This exists because they did not get there. `prisma/seed.ts` was the
 * only thing that wrote them, deploy runs `prisma migrate deploy` and
 * nothing else, and `tsx` is a devDependency, so the seed had not run
 * against production since whenever someone last ran it by hand.
 * Production was carrying 59 of 98 permissions and 9 of 24 templates.
 * Every route behind one of the missing 39 -- classes, HR, payroll,
 * appointments, expenses, the whole Business OS, and `portal.manage`,
 * which gates the member-invite button -- answered 403 to everyone
 * including the organization owner, because `ORG_OWNER` held 59 grants
 * where the catalog says 98.
 *
 * So the catalogs now converge the way the schema does: automatically,
 * as part of coming up, rather than when somebody remembers.
 *
 * Three properties this relies on:
 *
 * - **Idempotent, and cheap when there is nothing to do.** It runs on
 *   every boot, so the steady state has to be a handful of reads and no
 *   writes -- it diffs before it writes rather than upserting blindly.
 * - **Serialized.** Two instances booting together would race on the
 *   same rows, so the whole thing takes a transaction-scoped advisory
 *   lock; the second waits and then finds nothing to do.
 * - **Additive for permissions, authoritative for system roles.** A
 *   permission is never deleted: rows elsewhere reference it, and a key
 *   retired from the catalog is not a reason to drop grants underneath a
 *   running tenant. A *system* role's grant list, by contrast, is
 *   mirrored exactly -- the catalog is the definition of what
 *   `BRANCH_MANAGER` means, an organization that wants something else
 *   makes its own role (`organizationId` set), and this only ever
 *   touches rows with `organizationId` null.
 */

/** Stable name hashed into the advisory lock key. Changing it would let
 * an old and a new instance sync concurrently during a rollout. */
const LOCK_NAME = 'mygymagent:catalog-sync';

/** The sync does more work on a cold database (98 permissions, 14 roles
 * and their grants, 24 templates) than the 5s Prisma allows a
 * transaction by default. */
const TRANSACTION_TIMEOUT_MS = 120_000;
const MAX_WAIT_MS = 30_000;

export interface CatalogSyncReport {
  permissionsCreated: number;
  permissionsUpdated: number;
  rolesCreated: number;
  grantsAdded: number;
  grantsRemoved: number;
  templatesCreated: number;
  templatesUpdated: number;
}

export function catalogSyncChangedAnything(report: CatalogSyncReport): boolean {
  return Object.values(report).some((count) => count > 0);
}

export async function syncCatalogs(
  prisma: PrismaClient,
): Promise<CatalogSyncReport> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`;

      const report: CatalogSyncReport = {
        permissionsCreated: 0,
        permissionsUpdated: 0,
        rolesCreated: 0,
        grantsAdded: 0,
        grantsRemoved: 0,
        templatesCreated: 0,
        templatesUpdated: 0,
      };

      // -- Permissions ------------------------------------------------
      const existingPermissions = await tx.permission.findMany({
        select: {
          id: true,
          key: true,
          resource: true,
          action: true,
          description: true,
        },
      });
      const permissionByKey = new Map(
        existingPermissions.map((row) => [row.key, row]),
      );

      for (const wanted of PERMISSIONS_CATALOG) {
        const current = permissionByKey.get(wanted.key);
        if (!current) {
          const created = await tx.permission.create({
            data: wanted,
            select: { id: true, key: true },
          });
          permissionByKey.set(wanted.key, {
            ...wanted,
            id: created.id,
          } as (typeof existingPermissions)[number]);
          report.permissionsCreated += 1;
          continue;
        }
        const drifted =
          current.resource !== wanted.resource ||
          current.action !== wanted.action ||
          current.description !== wanted.description;
        if (drifted) {
          await tx.permission.update({
            where: { id: current.id },
            data: {
              resource: wanted.resource,
              action: wanted.action,
              description: wanted.description,
            },
          });
          report.permissionsUpdated += 1;
        }
      }

      // -- System roles and their grants ------------------------------
      for (const wanted of ROLES_CATALOG) {
        // A compound-unique `where` cannot take an explicit null, so the
        // organizationId-null row is found rather than upserted.
        let role = await tx.role.findFirst({
          where: { organizationId: null, key: wanted.key },
          select: { id: true, name: true, description: true },
        });
        if (!role) {
          role = await tx.role.create({
            data: {
              key: wanted.key,
              name: wanted.name,
              description: wanted.description,
              isSystem: true,
              organizationId: null,
            },
            select: { id: true, name: true, description: true },
          });
          report.rolesCreated += 1;
        } else if (
          role.name !== wanted.name ||
          role.description !== wanted.description
        ) {
          await tx.role.update({
            where: { id: role.id },
            data: { name: wanted.name, description: wanted.description },
          });
        }

        // A catalog key with no permission row would silently narrow the
        // role, so resolve against what actually exists and treat a
        // shortfall as a bug rather than as a smaller role.
        const wantedIds = new Set<string>();
        for (const key of wanted.permissions) {
          const permission = permissionByKey.get(key);
          if (!permission) {
            throw new Error(
              `Role ${wanted.key} grants "${key}", which is not in PERMISSIONS_CATALOG`,
            );
          }
          wantedIds.add(permission.id);
        }

        const currentGrants = await tx.rolePermission.findMany({
          where: { roleId: role.id },
          select: { permissionId: true },
        });
        const currentIds = new Set(currentGrants.map((g) => g.permissionId));

        // `RolePermission` is keyed on (roleId, permissionId) with no id
        // column, so extras are deleted by that pair.
        const toRemove = [...currentIds].filter((id) => !wantedIds.has(id));
        if (toRemove.length > 0) {
          await tx.rolePermission.deleteMany({
            where: { roleId: role.id, permissionId: { in: toRemove } },
          });
          report.grantsRemoved += toRemove.length;
        }

        const toAdd = [...wantedIds].filter((id) => !currentIds.has(id));
        if (toAdd.length > 0) {
          await tx.rolePermission.createMany({
            data: toAdd.map((permissionId) => ({
              roleId: role.id,
              permissionId,
            })),
            skipDuplicates: true,
          });
          report.grantsAdded += toAdd.length;
        }
      }

      // -- System-default message templates ---------------------------
      const existingTemplates = await tx.messageTemplate.findMany({
        where: { organizationId: null },
        select: {
          id: true,
          key: true,
          channel: true,
          subject: true,
          body: true,
        },
      });
      const templateByKey = new Map(
        existingTemplates.map((row) => [`${row.key}:${row.channel}`, row]),
      );

      for (const wanted of DEFAULT_TEMPLATES_CATALOG) {
        const current = templateByKey.get(`${wanted.key}:${wanted.channel}`);
        if (!current) {
          await tx.messageTemplate.create({
            data: {
              organizationId: null,
              key: wanted.key,
              channel: wanted.channel,
              subject: wanted.subject,
              body: wanted.body,
            },
          });
          report.templatesCreated += 1;
          continue;
        }
        if (
          current.subject !== (wanted.subject ?? null) ||
          current.body !== wanted.body
        ) {
          await tx.messageTemplate.update({
            where: { id: current.id },
            data: { subject: wanted.subject, body: wanted.body },
          });
          report.templatesUpdated += 1;
        }
      }

      return report;
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: MAX_WAIT_MS },
  );
}
