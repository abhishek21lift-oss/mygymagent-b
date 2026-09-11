import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListLeadFollowUpsQueryDto } from './dto/list-lead-follow-ups-query.dto';
import { LeadsService } from './leads.service';

/// Global lead follow-up worklist (the CRM follow-ups page). Kept as a
/// separate controller because its route (`/lead-follow-ups`) lives
/// outside the `/leads` prefix -- a follow-up worklist is a cross-lead
/// view, not a sub-resource of one lead.
@Controller('lead-follow-ups')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class LeadFollowUpsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermissions('leads.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLeadFollowUpsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leads.listFollowUps(user.organizationId!, query, branchScope);
  }
}
