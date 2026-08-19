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

    const [roleGrant, override] = await Promise.all([
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
      this.prisma.userPermissionOverride.findFirst({
        where: {
          userId,
          organizationId,
          permission: { key: permissionKey },
          OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])],
        },
        orderBy: { branchId: 'desc' }, // branch-specific override takes precedence over org-wide
        select: { effect: true },
      }),
    ]);

    if (override?.effect === 'DENY') return false;
    if (override?.effect === 'ALLOW') return true;
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
    for (const override of overrides) {
      if (override.effect === 'ALLOW') granted.add(override.permission.key);
      if (override.effect === 'DENY') granted.delete(override.permission.key);
    }
    return [...granted].sort();
  }
}
