import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Reads the caller's requested branch *filter* from the `x-branch-id`
 * header -- an unverified client hint used only to narrow a list query a
 * caller is already unrestricted on (e.g. "show me just Branch A"). It is
 * NOT an access check: a service must never use this value as the sole
 * gate for scoping a query to one branch. For the enforced restriction
 * derived from the caller's actual grants, see `@CurrentBranchScope()`
 * (`branch-scope.decorator.ts`) and `PermissionsGuard`'s class comment. */
export const RequestedBranchId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['x-branch-id'];
    return Array.isArray(header) ? header[0] : header;
  },
);
