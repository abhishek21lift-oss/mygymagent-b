import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Reads the caller's requested branch scope from the `x-branch-id` header.
 * This is a hint only -- callers must still verify (via BranchAccessGuard
 * or an explicit query) that the authenticated user actually has access to
 * that branch before using it to scope a query. */
export const RequestedBranchId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['x-branch-id'];
    return Array.isArray(header) ? header[0] : header;
  },
);
