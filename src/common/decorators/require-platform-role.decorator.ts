import { SetMetadata } from '@nestjs/common';
import type { PlatformRole } from '@prisma/client';

export const PLATFORM_ROLE_KEY = 'platformRole';

/**
 * Restricts a route to platform staff (User.platformRole set). With no
 * arguments, either PLATFORM_OWNER or PLATFORM_ADMIN is sufficient; pass
 * specific roles to require one of them.
 *
 * Deliberately separate from @RequirePermissions()/PermissionsGuard:
 * PermissionsService.hasPermission() always returns false for a null
 * organizationId (see its own comment), and platform routes operate across
 * every organization by design -- there is no single organizationId to
 * scope them to. Keeping this as its own guard/decorator, rather than
 * special-casing the RBAC path, keeps the "organizationId always scopes
 * normal endpoints" invariant true everywhere except this one deliberate,
 * clearly-marked exception (see docs/architecture/adr/0001, trade-offs).
 */
export const RequirePlatformRole = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLE_KEY, roles.length > 0 ? roles : true);
