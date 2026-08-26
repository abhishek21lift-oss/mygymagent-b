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
 * IMPORTANT: when a route requires multiple permissions (AND), a single
 * branch-scoped permission must keep the whole request branch-scoped even if
 * another required permission is org-wide. The previous implementation
 * could overwrite that restriction with null while processing a later
 * org-wide permission, creating a privilege-escalation path for future or
 * combined routes.
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
        const allowed = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
          branchId,
        );
        if (!allowed) {
          throw new ForbiddenException(`Missing permission: ${key}`);
        }

        const orgWide = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
        );

        if (!orgWide) {
          // The permission was satisfied only because of this branch.
          // Preserve that restriction across ALL AND-required permissions.
          branchScopedGrant = true;
          branchScope = branchId ?? null;
        }
      }
    }

    if (hasOr && requiredAny) {
      let matchedKey: string | undefined;
      for (const key of requiredAny) {
        const allowed = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
          branchId,
        );
        if (!allowed) continue;

        matchedKey = key;
        const orgWide = await this.permissionsService.hasPermission(
          user.id,
          user.organizationId,
          key,
        );

        // An OR match only introduces a branch restriction when the matched
        // permission itself is branch-scoped. Never clear an existing AND
        // restriction established above.
        if (!orgWide && !branchScopedGrant) {
          branchScopedGrant = true;
          branchScope = branchId ?? null;
        }
        break;
      }

      if (!matchedKey) {
        throw new ForbiddenException(
          `Missing permission: one of ${requiredAny.join(', ')}`,
        );
      }
      request.grantedViaPermission = matchedKey;
    }

    request.branchScope = branchScope;
    return true;
  }
}
