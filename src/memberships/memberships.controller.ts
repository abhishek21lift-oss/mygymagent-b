import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CancelMembershipDto } from './dto/cancel-membership.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { ExtendMembershipDto } from './dto/extend-membership.dto';
import { FreezeMembershipDto } from './dto/freeze-membership.dto';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';
import { PauseMembershipDto } from './dto/pause-membership.dto';
import { RecordPaymentFailureDto } from './dto/record-payment-failure.dto';
import { RenewMembershipDto } from './dto/renew-membership.dto';
import { TransferMembershipDto } from './dto/transfer-membership.dto';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get()
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMembershipsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membershipsService.list(
      user.organizationId!,
      query,
      query.memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Get('analytics/summary')
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  getAnalyticsSummary(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.getAnalyticsSummary(
      user.organizationId!,
      branchScope,
    );
  }

  @Get('renewal-reminders')
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  getRenewalReminders(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') daysRaw?: string,
    @CurrentBranchScope() branchScope?: string | null,
  ) {
    const days = daysRaw ? Number(daysRaw) : 7;
    return this.membershipsService.getRenewalReminders(
      user.organizationId!,
      Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7,
      branchScope ?? null,
    );
  }

  @Get('history/:id')
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.getHistory(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membershipsService.getOne(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('memberships.create')
  @Audited({ resource: 'membership', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.create(
      user.organizationId!,
      dto,
      branchScope,
    );
  }

  @Post(':id/freeze')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'freeze' })
  freeze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FreezeMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.freeze(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/resume')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'resume' })
  resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.resume(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Post(':id/cancel')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'cancel' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.cancel(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/renew')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'renew' })
  renew(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RenewMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.renew(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/activate')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'activate' })
  activate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.activate(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Post(':id/pause')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'pause' })
  pause(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PauseMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.pause(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/unpause')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'unpause' })
  unpause(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.unpause(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Post(':id/extend')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'extend' })
  extend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ExtendMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.extend(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/change-plan')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'change-plan' })
  changePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangePlanDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.changePlan(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/upgrade')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'upgrade' })
  upgrade(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangePlanDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    // Direction is derived from prices by readers of the chained rows;
    // upgrade/downgrade share changePlan's pro-rata chained-row write.
    return this.membershipsService.changePlan(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/downgrade')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'downgrade' })
  downgrade(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangePlanDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.changePlan(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/transfer')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'transfer' })
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransferMembershipDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.transfer(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/payment-failed')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'payment-failed' })
  recordPaymentFailure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RecordPaymentFailureDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipsService.recordPaymentFailure(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }
}
