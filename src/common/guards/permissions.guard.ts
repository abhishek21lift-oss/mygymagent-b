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

/**
 * Enforces @RequirePermissions() server-side. Registered globally
 * (APP_GUARD) so a route with no decorator is merely "authenticated"
 * (already enforced by JwtAuthGuard), while a route that declares
 * permissions is denied unless every one of them is satisfied.
 *
 * Never trusts organizationId/branchId from the request body -- reads them
 * from request.user (JWT-derived) and the x-branch-id header respectively.
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
    }
    return true;
  }
}
