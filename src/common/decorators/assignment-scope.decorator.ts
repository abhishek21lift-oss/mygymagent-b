import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** For a route gated by `@RequireAnyPermission('x.read', 'x.read_assigned')`
 * (or `x.create` / `x.create_assigned`): returns the caller's own userId if
 * their access was granted specifically through the `*_assigned` variant
 * (a trainer/nutritionist role restricted to their own clients), meaning
 * the service must filter results to `assignedTrainerId === this id`.
 * Returns null if access came through the broader non-suffixed permission
 * -- unrestricted, same as an org-wide `@CurrentBranchScope()`.
 *
 * The guard exposes whichever key actually satisfied the check
 * (`request.grantedViaPermission`); any `*_read_assigned` /
 * `*_create_assigned` key implies assignment scoping -- members,
 * memberships, attendance, workouts (plans, assignments, and session
 * execution) all grant their `*_assigned` variants to the TRAINER role and
 * every consumer service applies the returned scope the same way. */
export const CurrentAssignmentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const granted = request.grantedViaPermission;
    if (!granted) return null;
    const isAssignmentScoped =
      granted.endsWith('.read_assigned') ||
      granted.endsWith('.create_assigned');
    if (!isAssignmentScoped) return null;
    return request.user?.id ?? null;
  },
);
