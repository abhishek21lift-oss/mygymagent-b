import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PortalService } from './portal.service';

/**
 * The member-facing surface (F-P0-1).
 *
 * Note what is absent: no route takes a `memberId`, and no read route
 * declares a permission. Both are deliberate. The member is resolved
 * from the caller's own JWT via `Member.userId` and every query is
 * scoped to that id, so "their own data" holds because of the query
 * rather than a role grant that a later edit could widen.
 *
 * That is not hypothetical. The `MEMBER` role used to carry
 * `attendance.read`, `workouts.read` and `nutrition.read` -- the
 * org-wide reads that `GET /attendance` accepts -- so issuing it would
 * have let a member list every check-in in the gym. Those permissions
 * are gone, and this surface never needed them.
 */
@Controller('portal')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  /** Staff-side: grants a member portal login. The only route here that
   * names a member, and the only one behind a permission. */
  @Post('enable/:memberId')
  @RequirePermissions('portal.manage')
  @Audited({ resource: 'portal_login', action: 'enable' })
  enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
  ) {
    return this.portal.enablePortalLogin(
      user.organizationId!,
      user.id,
      memberId,
    );
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.portal.me(user.id);
  }

  @Get('memberships')
  memberships(@CurrentUser() user: AuthenticatedUser) {
    return this.portal.memberships(user.id);
  }

  @Get('attendance')
  attendance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number.parseInt(limit ?? '30', 10);
    return this.portal.attendance(
      user.id,
      Number.isFinite(parsed) ? parsed : 30,
    );
  }

  @Get('workouts')
  workouts(@CurrentUser() user: AuthenticatedUser) {
    return this.portal.workouts(user.id);
  }

  @Get('nutrition')
  nutrition(@CurrentUser() user: AuthenticatedUser) {
    return this.portal.nutrition(user.id);
  }
}
