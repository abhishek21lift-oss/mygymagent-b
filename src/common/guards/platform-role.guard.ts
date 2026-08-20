import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PlatformRole } from '@prisma/client';
import { PLATFORM_ROLE_KEY } from '../decorators/require-platform-role.decorator';

/**
 * Enforces @RequirePlatformRole() server-side. Registered globally
 * (APP_GUARD) so a route with no decorator is unaffected -- only routes
 * that explicitly opt in via @RequirePlatformRole() are restricted to
 * platform staff.
 */
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      PlatformRole[] | true | undefined
    >(PLATFORM_ROLE_KEY, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) throw new UnauthorizedException();

    if (!user.platformRole) {
      throw new ForbiddenException('Platform staff access required');
    }
    if (required !== true && !required.includes(user.platformRole)) {
      throw new ForbiddenException('Insufficient platform role');
    }
    return true;
  }
}
