import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListStockMovementsQueryDto } from './dto/list-stock-movements-query.dto';
import { StockMovementsService } from './stock-movements.service';

@Controller('stock-movements')
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
