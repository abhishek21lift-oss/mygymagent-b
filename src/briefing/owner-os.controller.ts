import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { OwnerOsService } from './owner-os.service';

/// The executive cockpit behind the frontend's Owner OS page
/// (`/owner-os` calls `GET /owner-os/briefing`). Same `reports.view`
/// tier as GET /briefing/daily -- an aggregation of data already
/// visible under that permission, not a new access grant.
@Controller('owner-os')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class OwnerOsController {
  constructor(private readonly ownerOs: OwnerOsService) {}

  @Get('briefing')
  @RequirePermissions('reports.view')
  getBriefing(@CurrentUser() user: AuthenticatedUser) {
    return this.ownerOs.getBriefing(user.organizationId!);
  }
}
