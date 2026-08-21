import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The caller's *enforced* branch restriction for the permission just
 * checked by PermissionsGuard: `null` if they hold it org-wide, otherwise
 * the one branchId they're allowed to touch. Unlike `@RequestedBranchId()`
 * (an unverified client-supplied hint used only to narrow an already-
 * unrestricted query), this value is derived server-side from the actor's
 * actual role/override grants and is safe to fold directly into a
 * service's `where` clause -- see PermissionsGuard's class comment. */
export const CurrentBranchScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.branchScope ?? null;
  },
);
