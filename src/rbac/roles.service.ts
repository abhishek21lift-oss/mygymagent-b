import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS_CATALOG } from './permissions.catalog';
import { PLATFORM_ONLY_ROLE_KEYS } from './roles.catalog';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Roles an organization's administrators may hand out.
   *
   * The platform roles are excluded. They are seeded into the same
   * global catalogue, but platform routes are gated on `User.platformRole`
   * rather than on an RBAC grant, so granting one inside an organization
   * confers nothing a platform role implies -- it only hands over every
   * ordinary permission under a name that says otherwise.
   */
  async listAssignable(organizationId: string) {
    const roles = await this.prisma.role.findMany({
      where: {
        OR: [{ organizationId }, { organizationId: null }],
        key: { notIn: [...PLATFORM_ONLY_ROLE_KEYS] },
      },
      include: {
        rolePermissions: { include: { permission: { select: { key: true } } } },
      },
      orderBy: [{ organizationId: 'asc' }, { name: 'asc' }],
    });

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      // Organization-specific rows shadow the global one of the same key,
      // which is how a gym would ever customise a role; say which this is.
      isOrganizationSpecific: role.organizationId !== null,
      permissions: role.rolePermissions.map((grant) => grant.permission.key),
    }));
  }

  /** The permission catalogue, so a role's grants can be shown as the
   * descriptions an operator reads rather than as bare keys. */
  permissionCatalog() {
    return PERMISSIONS_CATALOG;
  }
}
