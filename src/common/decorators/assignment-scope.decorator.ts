import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** For a route gated by `@RequireAnyPermission('members.read',
 * 'members.read_assigned')`: returns the caller's own userId if their
 * access was granted specifically through `members.read_assigned` (a
 * trainer/nutritionist role restricted to their own clients), meaning the
 * service must filter results to `assignedTrainerId === this id`. Returns
 * null if access came through the broader `members.read` -- unrestricted,
 * same as an org-wide `@CurrentBranchScope()`. */
export const CurrentAssignmentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (request.grantedViaPermission !== 'members.read_assigned') return null;
    return request.user?.id ?? null;
  },
);
