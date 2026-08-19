import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/** Declares the `resource.action` permission keys required to reach a
 * route. All keys must be satisfied (logical AND). Enforced by
 * PermissionsGuard, which is registered globally. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
