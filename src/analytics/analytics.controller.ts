import { Controller, Get, Query } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { GetRevenueSummaryQueryDto } from './dto/get-revenue-summary-query.dto';
import { GetRevenueTrendQueryDto } from './dto/get-revenue-trend-query.dto';
import { GetSalesFunnelQueryDto } from './dto/get-sales-funnel-query.dto';
import { FinanceService } from './finance.service';
import { InventoryIntelligenceService } from './inventory-intelligence.service';
import { MemberIntelligenceService } from './member-intelligence.service';
import { SalesIntelligenceService } from './sales-intelligence.service';
import { TrainerIntelligenceService } from './trainer-intelligence.service';

/// Every route here is guarded by `reports.view` -- these are all
/// read-only reporting/intelligence endpoints, the same permission tier
/// as GET /analytics/revenue (P1), not the resource-specific
/// members.read/leads.read/etc. permissions those resources' own CRUD
/// routes use.
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly finance: FinanceService,
    private readonly memberIntelligence: MemberIntelligenceService,
    private readonly salesIntelligence: SalesIntelligenceService,
    private readonly trainerIntelligence: TrainerIntelligenceService,
    private readonly inventoryIntelligence: InventoryIntelligenceService,
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
      branchScope,
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
      branchScope,
      query.months ?? 6,
    );
  }

  @Get('members/at-risk')
  @RequirePermissions('reports.view')
  getAtRiskMembers(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.memberIntelligence.getAtRiskMembers(
      user.organizationId!,
      branchScope,
    );
  }

  @Get('members/status-breakdown')
  @RequirePermissions('reports.view')
  getMemberStatusBreakdown(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.memberIntelligence.getStatusBreakdown(
      user.organizationId!,
      branchScope,
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
      branchScope,
      query,
    );
  }

  @Get('trainers/workload')
  @RequirePermissions('reports.view')
  getTrainerWorkload(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.trainerIntelligence.getWorkload(
      user.organizationId!,
      branchScope,
    );
  }

  @Get('inventory/forecast')
  @RequirePermissions('reports.view')
  getInventoryForecast(@CurrentUser() user: AuthenticatedUser) {
    return this.inventoryIntelligence.getStockForecast(user.organizationId!);
  }
}
