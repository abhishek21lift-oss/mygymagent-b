import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import { PriceEstimateDto } from './dto/price-estimate.dto';
import { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';
import { MembershipPlansService } from './membership-plans.service';
import { quotePlanPrice } from './plan-pricing';

@Controller('membership-plans')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class MembershipPlansController {
  constructor(private readonly plansService: MembershipPlansService) {}

  @Get()
  @RequirePermissions('membership_plans.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.plansService.list(user.organizationId!, query, branchScope);
  }

  /**
   * Pure price preview for the plan form. No database access: the form
   * shows this estimate, and the sale path recomputes from stored plan
   * values instead of trusting it.
   */
  @Post('price-estimate')
  @RequirePermissions('membership_plans.read')
  estimate(@Body() dto: PriceEstimateDto) {
    return quotePlanPrice(dto);
  }

  @Get(':id')
  @RequirePermissions('membership_plans.read')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.plansService.getOne(user.organizationId!, id, branchScope);
  }

  @Post()
  @RequirePermissions('membership_plans.create')
  @Audited({ resource: 'membership_plan', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMembershipPlanDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.plansService.create(user.organizationId!, dto, branchScope);
  }

  @Patch(':id')
  @RequirePermissions('membership_plans.update')
  @Audited({ resource: 'membership_plan', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMembershipPlanDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.plansService.update(user.organizationId!, id, dto, branchScope);
  }

  @Delete(':id')
  @RequirePermissions('membership_plans.delete')
  @Audited({ resource: 'membership_plan', action: 'delete' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.plansService.remove(user.organizationId!, id, branchScope);
  }
}
