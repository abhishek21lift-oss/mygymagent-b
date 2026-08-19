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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';
import { MembershipPlansService } from './membership-plans.service';

@Controller('membership-plans')
export class MembershipPlansController {
  constructor(private readonly plansService: MembershipPlansService) {}

  @Get()
  @RequirePermissions('membership_plans.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.plansService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('membership_plans.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.plansService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('membership_plans.create')
  @Audited({ resource: 'membership_plan', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMembershipPlanDto,
  ) {
    return this.plansService.create(user.organizationId!, dto);
  }

  @Patch(':id')
  @RequirePermissions('membership_plans.update')
  @Audited({ resource: 'membership_plan', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMembershipPlanDto,
  ) {
    return this.plansService.update(user.organizationId!, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('membership_plans.delete')
  @Audited({ resource: 'membership_plan', action: 'delete' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.plansService.remove(user.organizationId!, id);
  }
}
