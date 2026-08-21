import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes whether `userId` may perform `permissionKey` within
   * `organizationId`, optionally scoped to `branchId`.
   *
   * Resolution order:
   *  1. Collect permissions granted via roles assigned to the user that are
   *     either organization-wide (branchId null on the assignment) or
   *     scoped to the requested branch.
   *  2. Apply per-user overrides (UserPermissionOverride): DENY always wins
   *     over any role-derived ALLOW, and an explicit ALLOW override can
   *     grant access beyond the user's roles.
   *
   * organizationId must come from the authenticated JWT context, never
   * from client input -- callers (PermissionsGuard) are responsible for that.
   */
  async hasPermission(
    userId: string,
    organizationId: string | null,
    permissionKey: string,
    branchId?: string,
  ): Promise<boolean> {
    if (!organizationId) return false;

    const [roleGrant, overrides] = await Promise.all([
      this.prisma.userRole.findFirst({
        where: {
          userId,
          organizationId,
          OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])],
          role: {
            rolePermissions: { some: { permission: { key: permissionKey } } },
          },
        },
        select: { id: true },
      }),
      this.prisma.userPermissionOverride.findMany({
        where: {
          userId,
          organizationId,
          permission: { key: permissionKey },
          OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])],
        },
        select: { effect: true },
      }),
    ]);

    // DENY always wins, full stop -- regardless of whether it's the
    // branch-specific or the org-wide row. A single `findFirst` ordered by
    // branchId used to pick one row and trust its effect; in PostgreSQL
    // `ORDER BY branchId DESC` is NULLS FIRST, so that silently returned
    // the org-wide row before a branch-specific one, inverting this
    // invariant whenever a user held both an org-wide ALLOW and a
    // branch-specific DENY for the same key. Fetching every matching row
    // and checking for DENY explicitly closes that gap and matches
    // getEffectivePermissions()'s DENY-after-ALLOW resolution below.
    if (overrides.some((o) => o.effect === 'DENY')) return false;
    if (overrides.some((o) => o.effect === 'ALLOW')) return true;
    return roleGrant !== null;
  }

  /** Effective permission set for a user, for surfacing to the frontend
   * (e.g. GET /auth/me) so the UI can render permission-aware navigation.
   * Client-side use is for UX only -- every mutating endpoint still enforces
   * PermissionsGuard server-side regardless of what the client believes. */
  async getEffectivePermissions(
    userId: string,
    organizationId: string | null,
  ): Promise<string[]> {
    if (!organizationId) return [];

    const [roles, overrides] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId, organizationId },
        include: {
          role: {
            include: { rolePermissions: { include: { permission: true } } },
          },
        },
      }),
      this.prisma.userPermissionOverride.findMany({
        where: { userId, organizationId },
        include: { permission: true },
      }),
    ]);

    const granted = new Set<string>();
    for (const userRole of roles) {
      for (const rolePermission of userRole.role.rolePermissions) {
        granted.add(rolePermission.permission.key);
      }
    }
    // Two passes, not one: applying ALLOW/DENY in whatever order Prisma
    // returns the rows would make the result depend on that order whenever
    // a user holds both for the same key. DENY always wins (matching
    // hasPermission() above), so every ALLOW is added first and every DENY
    // is then removed, regardless of row order.
    for (const override of overrides) {
      if (override.effect === 'ALLOW') granted.add(override.permission.key);
    }
    for (const override of overrides) {
      if (override.effect === 'DENY') granted.delete(override.permission.key);
    }
    return [...granted].sort();
  }
}
