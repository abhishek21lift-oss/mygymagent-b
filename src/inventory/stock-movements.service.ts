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
    // Also confirms the product belongs to this org (404 otherwise). Only
    // used for the error message below and to fail fast on an unknown
    // product -- the actual stock guard is the conditional update inside
    // the transaction, not this read, so a stale read here can't cause an
    // incorrect decision.
    const product = await this.products.getOne(organizationId, productId);
    const delta = resolveDelta(dto.type, dto.quantity);

    const { movement, updatedProduct } = await this.prisma.$transaction(
      async (tx) => {
        const movement = await tx.stockMovement.create({
          data: {
            organizationId,
            productId,
            type: dto.type,
            quantity: delta,
            note: dto.note,
            recordedByUserId,
          },
        });

        // Atomic guard against overselling: the WHERE clause itself
        // requires enough stock to survive the decrement, so two
        // concurrent SALEs against the last unit can no longer both pass a
        // stale `quantityOnHand` read and both apply -- Postgres
        // serializes the two UPDATEs on the same row, and the second
        // one's WHERE simply matches zero rows once the first has
        // committed. `count === 0` means this guard rejected the
        // movement (the product's existence was already confirmed above),
        // which aborts the whole transaction, including the movement
        // insert above.
        const updateResult = await tx.product.updateMany({
          where: {
            id: productId,
            ...(delta < 0 ? { quantityOnHand: { gte: -delta } } : {}),
          },
          data: { quantityOnHand: { increment: delta } },
        });
        if (updateResult.count === 0) {
          throw new BadRequestException(
            `Insufficient stock: only ${product.quantityOnHand} unit(s) of "${product.name}" on hand`,
          );
        }

        const updatedProduct = await tx.product.findUniqueOrThrow({
          where: { id: productId },
        });
        return { movement, updatedProduct };
      },
    );

    // Only the crossing edge (was above the threshold, now at-or-below
    // it), not every movement that leaves stock at-or-below reorderLevel
    // -- otherwise every subsequent SALE while stock stays low would
    // re-emit and spam a listener with one alert per sale. `product` is
    // the pre-transaction read (a stale read here just means an alert
    // might fire once extra or once late under a rare race, which is
    // fine for a notification -- the atomic guard above is what protects
    // the actual quantityOnHand invariant, not this comparison).
    const wasAboveThreshold =
      product.quantityOnHand > updatedProduct.reorderLevel;
    const isAtOrBelowNow =
      updatedProduct.quantityOnHand <= updatedProduct.reorderLevel;
    if (wasAboveThreshold && isAtOrBelowNow) {
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
