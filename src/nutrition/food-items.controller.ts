import { Body, Controller, Get, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateFoodItemDto } from './dto/create-food-item.dto';
import { FoodItemsService } from './food-items.service';

@Controller('food-items')
export class FoodItemsController {
  constructor(private readonly foodItemsService: FoodItemsService) {}

  @Get()
  @RequirePermissions('nutrition.read')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.foodItemsService.list(user.organizationId!);
  }

  @Post()
  @RequirePermissions('nutrition.create')
  @Audited({ resource: 'food_item', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFoodItemDto,
  ) {
    return this.foodItemsService.create(user.organizationId!, dto);
  }
}
