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
import {
  PERMISSIONS_ANY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';

declare module 'express-serve-static-core' {
  interface Request {
    /** Resolved branch scope. Never read the raw x-branch-id header in handlers. */
    branchScope?: string | null;
    /** Permission that satisfied @RequireAnyPermission(), when applicable. */
    grantedViaPermission?: string;
  }
}

/**
 * Global permission guard. Authentication is handled by JwtAuthGuard; this
 * guard resolves authorization scope from the authenticated user and the
 * requested branch.
 *
 * For every permission we first test the organization-wide grant. If it is
 * present, no branch header is needed. Otherwise we test the requested
 * branch. This avoids rejecting an org-wide grant merely because a branch
 * header was supplied, while preserving the narrowest branch scope for
 * branch-only grants on AND routes.
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
    const requiredAny = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_ANY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasAnd = Boolean(required && required.length > 0);
    const hasOr = Boolean(requiredAny && requiredAny.length > 0);
    if (!hasAnd && !hasOr) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) throw new UnauthorizedException();

    const branchIdHeader = request.headers['x-branch-id'];
    const branchId = Array.isArray(branchIdHeader)
      ? branchIdHeader[0]
      : branchIdHeader;

    let branchScope: string | null = null;
    let branchScopedGrant = false;

    if (hasAnd && required) {
      for (const key of required) {
        const orgWide = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
        );

        if (orgWide) continue;

        const branchAllowed = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
          branchId,
        );
        if (!branchAllowed) {
          throw new ForbiddenException(`Missing permission: ${key}`);
        }

        // The permission was satisfied only because of this branch.
        // Preserve that restriction across ALL AND-required permissions.
        branchScopedGrant = true;
        branchScope = branchId ?? null;
      }
    }

    if (hasOr && requiredAny) {
      let matchedKey: string | undefined;
      let matchedOrgWide = false;

      for (const key of requiredAny) {
        const orgWide = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
        );

        if (orgWide) {
          matchedKey = key;
          matchedOrgWide = true;
          break;
        }

        const branchAllowed = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
          branchId,
        );
        if (branchAllowed) {
          matchedKey = key;
          break;
        }
      }

      if (!matchedKey) {
        throw new ForbiddenException(
          `Missing permission: one of ${requiredAny.join(', ')}`,
        );
      }

      request.grantedViaPermission = matchedKey;
      if (!matchedOrgWide && !branchScopedGrant) {
        branchScopedGrant = true;
        branchScope = branchId ?? null;
      }
    }

    request.branchScope = branchScope;
    return true;
  }
}
