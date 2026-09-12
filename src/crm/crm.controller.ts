import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { LeadsService } from './leads.service';

/// WS-3 speed-to-lead SLA readout. Lives under `/crm` (not `/leads`) per
/// the WS-3 spec -- the SLA is a cross-lead aggregate, not a sub-resource
/// of one lead.
@Controller('crm')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class CrmController {
  constructor(private readonly leads: LeadsService) {}

  @Get('sla')
  @RequirePermissions('leads.read')
  getSla(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leads.getSla(user.organizationId!, branchScope);
  }
}
