import {
  Body,
  Controller,
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
import { AssignDietPlanDto } from './dto/assign-diet-plan.dto';
import { CreateDietPlanDto } from './dto/create-diet-plan.dto';
import { UpdateDietPlanDto } from './dto/update-diet-plan.dto';
import { DietPlansService } from './diet-plans.service';

@Controller('diet-plans')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class DietPlansController {
  constructor(private readonly dietPlansService: DietPlansService) {}

  @Get()
  @RequirePermissions('nutrition.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.dietPlansService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('nutrition.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dietPlansService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('nutrition.create')
  @Audited({ resource: 'diet_plan', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDietPlanDto,
  ) {
    return this.dietPlansService.create(user.organizationId!, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('nutrition.create')
  @Audited({ resource: 'diet_plan', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDietPlanDto,
  ) {
    return this.dietPlansService.update(user.organizationId!, id, dto);
  }

  @Post(':id/assign')
  @RequirePermissions('nutrition.assign')
  @Audited({ resource: 'diet_assignment', action: 'create' })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignDietPlanDto,
  ) {
    return this.dietPlansService.assign(user.organizationId!, id, dto, user.id);
  }
}
