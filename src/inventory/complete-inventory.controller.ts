import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateInventorySaleDto, CreateInventorySupplierDto, CreateInventoryTransferDto,
  CreatePurchaseOrderDto, InventoryQueryDto, ReceivePurchaseOrderDto,
  UpdateInventorySupplierDto,
} from './dto/complete-inventory.dto';
import { CompleteInventoryService } from './complete-inventory.service';

@Controller('inventory')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class CompleteInventoryController {
  constructor(private readonly inventory: CompleteInventoryService) {}

  @Get('dashboard')
  @RequirePermissions('inventory.read')
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.dashboard(user.organizationId!);
  }

  @Get('branch-stock')
  @RequirePermissions('inventory.read')
  branchStock(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventory.branchStock(user.organizationId!, query);
  }

  @Get('reorder-suggestions')
  @RequirePermissions('inventory.read')
  reorderSuggestions(@CurrentUser() user: AuthenticatedUser, @Query('branchId') branchId?: string) {
    return this.inventory.reorderSuggestions(user.organizationId!, branchId);
  }

  @Get('suppliers')
  @RequirePermissions('inventory.read')
  suppliers(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventory.listSuppliers(user.organizationId!, query);
  }

  @Post('suppliers')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_supplier', action: 'create' })
  createSupplier(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateInventorySupplierDto) {
    return this.inventory.createSupplier(user.organizationId!, dto);
  }

  @Patch('suppliers/:id')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_supplier', action: 'update' })
  updateSupplier(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateInventorySupplierDto) {
    return this.inventory.updateSupplier(user.organizationId!, id, dto);
  }

  @Get('purchase-orders')
  @RequirePermissions('inventory.read')
  purchaseOrders(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventory.listPurchaseOrders(user.organizationId!, query);
  }

  @Post('purchase-orders')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_purchase_order', action: 'create' })
  createPurchaseOrder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePurchaseOrderDto) {
    return this.inventory.createPurchaseOrder(user.organizationId!, dto);
  }

  @Post('purchase-orders/:id/receive')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_purchase_receipt', action: 'create' })
  receivePurchaseOrder(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReceivePurchaseOrderDto) {
    return this.inventory.receivePurchaseOrder(user.organizationId!, id, dto, user.id);
  }

  @Get('transfers')
  @RequirePermissions('inventory.read')
  transfers(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventory.listTransfers(user.organizationId!, query);
  }

  @Post('transfers')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_transfer', action: 'create' })
  createTransfer(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateInventoryTransferDto) {
    return this.inventory.createTransfer(user.organizationId!, dto);
  }

  @Post('transfers/:id/ship')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_transfer', action: 'ship' })
  shipTransfer(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.inventory.shipTransfer(user.organizationId!, id, user.id);
  }

  @Post('transfers/:id/receive')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_transfer', action: 'receive' })
  receiveTransfer(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.inventory.receiveTransfer(user.organizationId!, id, user.id);
  }

  @Get('sales')
  @RequirePermissions('inventory.read')
  sales(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventory.listSales(user.organizationId!, query);
  }

  @Post('sales')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_sale', action: 'create' })
  createSale(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateInventorySaleDto) {
    return this.inventory.createSale(user.organizationId!, dto, user.id);
  }

  @Post('sales/:id/return')
  @RequirePermissions('inventory.manage')
  @Audited({ resource: 'inventory_sale', action: 'return' })
  returnSale(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.inventory.returnSale(user.organizationId!, id, user.id);
  }
}
