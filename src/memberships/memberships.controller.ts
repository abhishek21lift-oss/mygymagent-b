import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CancelMembershipDto } from './dto/cancel-membership.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { FreezeMembershipDto } from './dto/freeze-membership.dto';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';
import { RenewMembershipDto } from './dto/renew-membership.dto';
import { ExtendMembershipDto, MembershipPlanChangeDto, PauseMembershipDto, PaymentFailureDto, ReminderQueryDto, TransferMembershipDto } from './dto/membership-lifecycle.dto';
import { MembershipLifecycleService } from './membership-lifecycle.service';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService, private readonly lifecycle: MembershipLifecycleService) {}

  @Get()
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListMembershipsQueryDto, @CurrentBranchScope() branchScope: string | null, @CurrentAssignmentScope() assignmentScope: string | null) {
    return this.membershipsService.list(user.organizationId!, query, query.memberId, branchScope, assignmentScope);
  }

  @Get('analytics/summary')
  @RequirePermissions('memberships.read')
  analytics(@CurrentUser() user: AuthenticatedUser, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.analytics(user.organizationId!, branchScope);
  }

  @Get('renewal-reminders')
  @RequirePermissions('memberships.read')
  renewalReminders(@CurrentUser() user: AuthenticatedUser, @Query() query: ReminderQueryDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.renewalReminders(user.organizationId!, branchScope, query.days ?? 7);
  }

  @Get(':id')
  @RequireAnyPermission('memberships.read', 'memberships.read_assigned')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @CurrentBranchScope() branchScope: string | null, @CurrentAssignmentScope() assignmentScope: string | null) {
    return this.membershipsService.getOne(user.organizationId!, id, branchScope, assignmentScope);
  }

  @Post()
  @RequirePermissions('memberships.create')
  @Audited({ resource: 'membership', action: 'create' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.membershipsService.create(user.organizationId!, dto, branchScope);
  }

  @Post(':id/activate')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'activate' })
  activate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.activate(user.organizationId!, id, branchScope, user.id);
  }

  @Post(':id/pause')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'pause' })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: PauseMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.pause(user.organizationId!, id, dto, branchScope, user.id);
  }

  @Post(':id/freeze')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'freeze' })
  freeze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: FreezeMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.membershipsService.freeze(user.organizationId!, id, dto, branchScope);
  }

  @Post(':id/resume')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'resume' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.resume(user.organizationId!, id, branchScope, user.id);
  }

  @Post(':id/extend')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'extend' })
  extend(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ExtendMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.extend(user.organizationId!, id, dto, branchScope, user.id);
  }

  @Post(':id/upgrade')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'upgrade' })
  upgrade(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MembershipPlanChangeDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.changePlan(user.organizationId!, id, dto, branchScope, user.id);
  }

  @Post(':id/downgrade')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'downgrade' })
  downgrade(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MembershipPlanChangeDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.changePlan(user.organizationId!, id, dto, branchScope, user.id);
  }

  @Post(':id/transfer')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'transfer' })
  transfer(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: TransferMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.transfer(user.organizationId!, id, dto, branchScope, user.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'cancel' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CancelMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.membershipsService.cancel(user.organizationId!, id, dto, branchScope);
  }

  @Post(':id/renew')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'renew' })
  renew(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RenewMembershipDto, @CurrentBranchScope() branchScope: string | null) {
    return this.membershipsService.renew(user.organizationId!, id, dto, branchScope);
  }

  @Post(':id/payment-failed')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'payment_failed' })
  paymentFailed(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: PaymentFailureDto, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.recordPaymentFailure(user.organizationId!, id, dto, branchScope, user.id);
  }

  @Post('expire-due')
  @RequirePermissions('memberships.update')
  expireDue(@CurrentUser() user: AuthenticatedUser, @CurrentBranchScope() branchScope: string | null) {
    return this.lifecycle.expireDue(user.organizationId!, branchScope, user.id);
  }
}
