import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';
export const PERMISSIONS_ANY_KEY = 'permissions_any';
export const ASSIGNED_ONLY_UNLESS_KEY = 'assigned_only_unless';

/** Declares the `resource.action` permission keys required to reach a
 * route. All keys must be satisfied (logical AND). Enforced by
 * PermissionsGuard, which is registered globally. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Like @RequirePermissions(), but any one of the listed keys is enough
 * (logical OR) -- for a route reachable through more than one permission
 * that implies different result scoping, e.g. `members.read` (everyone in
 * scope) vs. `members.read_assigned` (only the caller's own assigned
 * members). PermissionsGuard records *which* key actually matched as
 * `request.grantedViaPermission`, readable via `@CurrentAssignmentScope()`
 * or directly, so the handler can tell the two apart. */
export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_ANY_KEY, permissions);

/** For a write route whose permission a trainer holds (`workouts.assign`,
 * `pt-sessions.update`, ...): a caller who lacks `readPermission` -- who
 * can only see their own assigned members -- may only act on those
 * members too. PermissionsGuard sets `request.assignedOnly`, and
 * `@CurrentAssignmentScope()` then returns the caller's id, which the
 * service folds into its `where` the way the read routes already do. */
export const AssignedOnlyUnless = (readPermission: string) =>
  SetMetadata(ASSIGNED_ONLY_UNLESS_KEY, readPermission);
