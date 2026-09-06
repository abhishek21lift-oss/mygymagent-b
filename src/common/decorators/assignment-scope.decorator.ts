import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Returns the caller's userId when the permission guard granted an
 * assignment-scoped permission (for example members.read_assigned).
 * Any *_assigned grant implies trainer/client assignment scoping.
 */
export const CurrentAssignmentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const granted = request.grantedViaPermission;
    if (!granted) return null;
    if (
      !granted.endsWith('.read_assigned') &&
      !granted.endsWith('.create_assigned') &&
      !granted.endsWith('.update_assigned') &&
      !granted.endsWith('.delete_assigned')
    ) {
      return null;
    }
    return request.user?.id ?? null;
  },
);
