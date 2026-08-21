import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StockMovementType } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { DomainEvent, type InventoryLowEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import type { ListStockMovementsQueryDto } from './dto/list-stock-movements-query.dto';
import { ProductsService } from './products.service';

/** Converts the caller-supplied `quantity` into the signed delta actually
 * applied to Product.quantityOnHand -- see CreateStockMovementDto. */
function resolveDelta(type: StockMovementType, quantity: number): number {
  switch (type) {
    case StockMovementType.RESTOCK:
      if (quantity <= 0) {
        throw new BadRequestException('RESTOCK quantity must be positive');
      }
      return quantity;
    case StockMovementType.SALE:
    case StockMovementType.DAMAGED:
      if (quantity <= 0) {
        throw new BadRequestException(`${type} quantity must be positive`);
      }
      return -quantity;
    case StockMovementType.ADJUSTMENT:
      return quantity;
  }
}

@Injectable()
export class StockMovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly events: EventEmitter2,
  ) {}

  async list(organizationId: string, query: ListStockMovementsQueryDto) {
    const where = {
      organizationId,
      ...(query.productId ? { productId: query.productId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: { product: { select: { id: true, name: true, sku: true } } },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async record(
    organizationId: string,
    productId: string,
    dto: CreateStockMovementDto,
    recordedByUserId: string,
  ) {
    // Also confirms the product belongs to this org (404 otherwise).
    const product = await this.products.getOne(organizationId, productId);
    const delta = resolveDelta(dto.type, dto.quantity);
    const newQuantity = product.quantityOnHand + delta;
    if (newQuantity < 0) {
      throw new BadRequestException(
        `Insufficient stock: only ${product.quantityOnHand} unit(s) of "${product.name}" on hand`,
      );
    }

    const [movement, updatedProduct] = await this.prisma.$transaction([
      this.prisma.stockMovement.create({
        data: {
          organizationId,
          productId,
          type: dto.type,
          quantity: delta,
          note: dto.note,
          recordedByUserId,
        },
      }),
      this.prisma.product.update({
        where: { id: productId },
        data: { quantityOnHand: { increment: delta } },
      }),
    ]);

    if (updatedProduct.quantityOnHand <= updatedProduct.reorderLevel) {
      const payload: InventoryLowEvent = {
        organizationId,
        productId: updatedProduct.id,
        sku: updatedProduct.sku,
        name: updatedProduct.name,
        quantityOnHand: updatedProduct.quantityOnHand,
        reorderLevel: updatedProduct.reorderLevel,
      };
      this.events.emit(DomainEvent.InventoryLow, payload);
    }

    return movement;
  }
}
