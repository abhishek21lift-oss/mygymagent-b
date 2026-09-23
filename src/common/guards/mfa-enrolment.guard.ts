import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ALLOW_PENDING_MFA_ENROLMENT_KEY } from '../decorators/allow-pending-mfa-enrolment.decorator';

/**
 * Confines a session belonging to a privileged user who owes their
 * organization a second factor to the enrolment screens and nothing else.
 *
 * Registered globally, immediately after JwtAuthGuard: the restriction has
 * to apply to every route by default, because an allowlist is only safe if
 * forgetting to add a route makes it *less* reachable, not more. Routes
 * opt back in with @AllowPendingMfaEnrolment().
 *
 * `mfaEnrolmentRequired` is recomputed by JwtStrategy on every request
 * rather than carried in the token, so finishing enrolment lifts the
 * restriction on the very next call -- no token rotation, no waiting out
 * an access token's 15 minutes.
 */
@Injectable()
export class MfaEnrolmentGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    // Unauthenticated or public routes are JwtAuthGuard's business.
    if (!user?.mfaEnrolmentRequired) return true;

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_PENDING_MFA_ENROLMENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    throw new ForbiddenException(
      'Two-factor authentication is required for your role. Set it up to continue.',
    );
  }
}
