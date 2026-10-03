import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequirePlatformRole } from '../common/decorators/require-platform-role.decorator';
import { SnapshotQueryDto } from './dto/snapshot-query.dto';
import { SnapshotService } from './snapshot.service';

/**
 * Platform-staff-only operational telemetry.
 *
 * `@RequirePlatformRole()` with no arguments accepts either PLATFORM_OWNER
 * or PLATFORM_ADMIN, enforced by PlatformRoleGuard server-side. It is on the
 * controller, never per route, so there is no handler in this file that a
 * later edit could leave unguarded.
 *
 * Deliberately not `@RequirePermissions(...)`: PermissionsService returns
 * false for a null organizationId (which is exactly why platform staff
 * cannot hold org grants), so a permission here could never be satisfied.
 * Same reasoning, and same trade-off, as PlatformOrganizationsController --
 * see ADR 0001.
 */
@Controller('platform/command-center')
@RequirePlatformRole()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CommandCenterController {
  constructor(private readonly snapshots: SnapshotService) {}

  /**
   * Every card in one response, so the console renders a consistent picture
   * rather than a grid that fills in incoherently card by card.
   *
   * `refresh=true` bypasses the 10s snapshot cache -- this is the "re-probe
   * now" affordance for an operator who does not believe a card.
   */
  @Get('snapshot')
  snapshot(@Query() query: SnapshotQueryDto) {
    return this.snapshots.collect({ bypassCache: query.refreshRequested });
  }
}
