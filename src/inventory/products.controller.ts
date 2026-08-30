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
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import { StockMovementsService } from './stock-movements.service';

@Controller('products')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly stockMovementsService: StockMovementsService,
  ) {}

  @Get()
  @RequirePermissions('inventory.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListProductsQueryDto,
  ) {
    return this.productsService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('inventory.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.productsService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'product', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProductDto,
  ) {
    return this.productsService.create(user.organizationId!, dto);
  }

  @Patch(':id')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'product', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(user.organizationId!, id, dto);
  }

  @Post(':id/stock-movements')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'stock_movement', action: 'create' })
  recordStockMovement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateStockMovementDto,
  ) {
    return this.stockMovementsService.record(
      user.organizationId!,
      id,
      dto,
      user.id,
    );
  }
}
