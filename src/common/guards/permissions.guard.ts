import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PermissionsService } from '../../rbac/permissions.service';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by PermissionsGuard: `null` if the caller holds every required
     * permission org-wide, otherwise the single branchId that satisfied
     * the check (see the guard's class comment). Read via
     * `@CurrentBranchScope()`, never from the raw `x-branch-id` header --
     * that header is an unverified client claim. */
    branchScope?: string | null;
  }
}

/**
 * Enforces @RequirePermissions() server-side. Registered globally
 * (APP_GUARD) so a route with no decorator is merely "authenticated"
 * (already enforced by JwtAuthGuard), while a route that declares
 * permissions is denied unless every one of them is satisfied.
 *
 * Never trusts organizationId/branchId from the request body -- reads them
 * from request.user (JWT-derived) and the x-branch-id header respectively.
 *
 * A role can be granted org-wide or scoped to one branch
 * (`UserRole.branchId`). This guard only decides *whether* the caller may
 * proceed; it doesn't know which resource the handler is about to touch, so
 * it can't by itself stop a branch-scoped manager from reaching another
 * branch's data. To close that gap, it also resolves *how* the permission
 * was granted -- org-wide, or only for the requested branch -- and exposes
 * that as `request.branchScope` (null = unrestricted) for service methods
 * to fold into their `where` clause the same way `organizationId` already
 * is. Every route in this codebase requires exactly one permission key
 * today, so the scope of the last (only) key checked is what's exposed;
 * see the loop below if that ever stops being true.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) throw new UnauthorizedException();

    const branchIdHeader = request.headers['x-branch-id'];
    const branchId = Array.isArray(branchIdHeader)
      ? branchIdHeader[0]
      : branchIdHeader;

    let branchScope: string | null = null;
    for (const key of required) {
      const allowed = await this.permissionsService.hasPermission(
        user.id,
        user.organizationId,
        key,
        branchId,
      );
      if (!allowed) {
        throw new ForbiddenException(`Missing permission: ${key}`);
      }

      // Re-check without a branch context: if that alone still grants the
      // permission, the caller holds it org-wide and no restriction
      // applies. Otherwise the branch header above is the only reason
      // access was allowed, so scope the caller to exactly that branch.
      const orgWide = await this.permissionsService.hasPermission(
        user.id,
        user.organizationId,
        key,
      );
      branchScope = orgWide ? null : (branchId ?? branchScope);
    }
    request.branchScope = branchScope;
    return true;
  }
}
