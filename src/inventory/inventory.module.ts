import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockMovementsController } from './stock-movements.controller';
import { StockMovementsService } from './stock-movements.service';

/**
 * v1 inventory scope: a flat product catalog plus an append-only stock
 * movement ledger (restock/sale/adjustment/damaged). No suppliers or
 * purchase-order workflow yet. See README.md.
 */
@Module({
  controllers: [ProductsController, StockMovementsController],
  providers: [ProductsService, StockMovementsService],
  exports: [ProductsService, StockMovementsService],
})
export class InventoryModule {}
