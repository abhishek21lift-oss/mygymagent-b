import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListStockMovementsQueryDto } from './dto/list-stock-movements-query.dto';
import { StockMovementsService } from './stock-movements.service';

@Controller('stock-movements')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class StockMovementsController {
  constructor(private readonly stockMovementsService: StockMovementsService) {}

  @Get()
  @RequirePermissions('inventory.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListStockMovementsQueryDto,
  ) {
    return this.stockMovementsService.list(user.organizationId!, query);
  }
}
