/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { CompleteInventoryController } from './complete-inventory.controller';
import { CompleteInventoryService } from './complete-inventory.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockMovementsController } from './stock-movements.controller';
import { StockMovementsService } from './stock-movements.service';

/**
 * Complete Inventory OS:
 * catalog + branch stock + append-only ledger + suppliers + procurement +
 * receiving + transfers + POS sales/returns + valuation/reorder intelligence.
 */
@Module({
  controllers: [
    ProductsController,
    StockMovementsController,
    CompleteInventoryController,
  ],
  providers: [ProductsService, StockMovementsService, CompleteInventoryService],
  exports: [ProductsService, StockMovementsService, CompleteInventoryService],
})
export class InventoryModule {}
