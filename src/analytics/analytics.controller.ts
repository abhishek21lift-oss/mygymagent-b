import { Controller, Get, Query } from '@nestjs/common';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  BranchFilterQueryDto,
  effectiveBranch,
} from '../common/branch/branch-filter';
import { GetRevenueSummaryQueryDto } from './dto/get-revenue-summary-query.dto';
import { GetRevenueTrendQueryDto } from './dto/get-revenue-trend-query.dto';
import { GetSalesFunnelQueryDto } from './dto/get-sales-funnel-query.dto';
import { FinanceService } from './finance.service';
import { InventoryIntelligenceService } from './inventory-intelligence.service';
import { MemberIntelligenceService } from './member-intelligence.service';
import { MembershipLifecycleService } from './membership-lifecycle.service';
import { OperationsIntelligenceService } from './operations-intelligence.service';
import { SalesIntelligenceService } from './sales-intelligence.service';
import { TrainerIntelligenceService } from './trainer-intelligence.service';

/// Every route here is guarded by `reports.view` -- these are all
/// read-only reporting/intelligence endpoints, the same permission tier
/// as GET /analytics/revenue (P1), not the resource-specific
/// members.read/leads.read/etc. permissions those resources' own CRUD
/// routes use.
@Controller('analytics')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AnalyticsController {
  constructor(
    private readonly finance: FinanceService,
    private readonly memberIntelligence: MemberIntelligenceService,
    private readonly salesIntelligence: SalesIntelligenceService,
    private readonly trainerIntelligence: TrainerIntelligenceService,
    private readonly inventoryIntelligence: InventoryIntelligenceService,
    private readonly membershipLifecycle: MembershipLifecycleService,
    private readonly operations: OperationsIntelligenceService,
  ) {}

  @Get('revenue')
  @RequirePermissions('reports.view')
  getRevenueSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetRevenueSummaryQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.finance.getRevenueSummary(
      user.organizationId!,
      query,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('revenue/trend')
  @RequirePermissions('reports.view')
  getRevenueTrend(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetRevenueTrendQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.finance.getRevenueTrend(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
      query.months ?? 6,
    );
  }

  @Get('members/at-risk')
  @RequirePermissions('reports.view')
  getAtRiskMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.memberIntelligence.getAtRiskMembers(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('members/status-breakdown')
  @RequirePermissions('reports.view')
  getMemberStatusBreakdown(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.memberIntelligence.getStatusBreakdown(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('members/win-back')
  @RequirePermissions('reports.view')
  getWinBackCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.memberIntelligence.getWinBackCandidates(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('operations-health')
  @RequirePermissions('reports.view')
  getOperationsHealth(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.operations.getOperationsHealth(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('classes/capacity')
  @RequirePermissions('reports.view')
  getClassCapacity(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.operations.getClassCapacity(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('scheduling/conflicts')
  @RequirePermissions('reports.view')
  getSchedulingConflicts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.operations.getSchedulingConflicts(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('pt-adherence')
  @RequireAnyPermission('workouts.read', 'workouts.read_assigned')
  getPtAdherence(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.memberIntelligence.getPtAdherence(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Get('sales/funnel')
  @RequirePermissions('reports.view')
  getSalesFunnel(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetSalesFunnelQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.salesIntelligence.getFunnel(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
      query,
    );
  }

  @Get('sales/priority')
  @RequirePermissions('reports.view')
  getSalesPriority(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.salesIntelligence.getSalesPriority(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('sales/sources')
  @RequirePermissions('reports.view')
  getSalesSources(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetSalesFunnelQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.salesIntelligence.getSourcePerformance(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
      query,
    );
  }

  @Get('sales/lost-reasons')
  @RequirePermissions('reports.view')
  getSalesLostReasons(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetSalesFunnelQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.salesIntelligence.getLostReasons(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
      query,
    );
  }

  @Get('sales/assignees')
  @RequirePermissions('reports.view')
  getSalesAssignees(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetSalesFunnelQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.salesIntelligence.getAssigneePerformance(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
      query,
    );
  }

  @Get('memberships/lifecycle')
  @RequirePermissions('reports.view')
  getMembershipLifecycle(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipLifecycle.getLifecycle(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('memberships/renewal-pipeline')
  @RequirePermissions('reports.view')
  getRenewalPipeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membershipLifecycle.getRenewalPipeline(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('trainers/workload')
  @RequirePermissions('reports.view')
  getTrainerWorkload(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.trainerIntelligence.getWorkload(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('trainers/pt-opportunities')
  @RequirePermissions('reports.view')
  getPtOpportunities(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.trainerIntelligence.getPtOpportunities(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }

  @Get('inventory/forecast')
  @RequirePermissions('reports.view')
  getInventoryForecast(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BranchFilterQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.inventoryIntelligence.getStockForecast(
      user.organizationId!,
      effectiveBranch(branchScope, query.branchId),
    );
  }
}
