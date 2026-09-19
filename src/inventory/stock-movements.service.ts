/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StockMovementType } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { DomainEvent, type InventoryLowEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import type { ListStockMovementsQueryDto } from './dto/list-stock-movements-query.dto';
import { ProductsService } from './products.service';

function resolveDelta(type: StockMovementType, quantity: number): number {
  switch (type) {
    case StockMovementType.RESTOCK:
    case StockMovementType.OPENING:
    case StockMovementType.TRANSFER_IN:
    case StockMovementType.RETURN:
      if (quantity <= 0) throw new BadRequestException(`${type} quantity must be positive`);
      return quantity;
    case StockMovementType.SALE:
    case StockMovementType.DAMAGED:
    case StockMovementType.TRANSFER_OUT:
      if (quantity <= 0) throw new BadRequestException(`${type} quantity must be positive`);
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

  async list(organizationId: string, query: ListStockMovementsQueryDto, branchScope: string | null = null) {
    if (branchScope && query.branchId && query.branchId !== branchScope) {
      throw new ForbiddenException('Inventory access is restricted to the assigned branch');
    }
    const effectiveBranchId = branchScope ?? query.branchId;
    const where = {
      organizationId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(effectiveBranchId ? { branchId: effectiveBranchId } : {}),
      ...(query.type ? { type: query.type as StockMovementType } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          product: { select: { id: true, name: true, sku: true } },
          branch: { select: { id: true, name: true } },
        },
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
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId && dto.branchId !== branchScope) {
      throw new ForbiddenException('Inventory access is restricted to the assigned branch');
    }
    const effectiveBranchId = branchScope ?? dto.branchId;
    const product = await this.products.getOne(organizationId, productId);
    if (!product.isActive) throw new BadRequestException('Inactive products cannot receive stock movements');
    const delta = resolveDelta(dto.type, dto.quantity);

    if (effectiveBranchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: effectiveBranchId, organizationId },
      });
      if (!branch) throw new NotFoundException('Branch not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (!effectiveBranchId) {
        const branchStockCount = await tx.productStock.count({ where: { organizationId, productId } });
        if (branchStockCount > 0) {
          throw new BadRequestException('Branch-scoped stock must be mutated through a branch-scoped inventory operation');
        }
      }
      if (effectiveBranchId) {
        await tx.productStock.upsert({
          where: {
            organizationId_branchId_productId: {
              organizationId,
              branchId: effectiveBranchId,
              productId,
            },
          },
          create: { organizationId, branchId: effectiveBranchId, productId, quantityOnHand: 0 },
          update: {},
        });
      }

      if (effectiveBranchId) {
        const branchResult = await tx.productStock.updateMany({
          where: {
            organizationId,
            branchId: effectiveBranchId,
            productId,
            ...(delta < 0 ? { quantityOnHand: { gte: -delta } } : {}),
          },
          data: { quantityOnHand: { increment: delta } },
        });
        if (branchResult.count === 0) {
          throw new BadRequestException(`Insufficient branch stock for "${product.name}"`);
        }

        const aggregate = await tx.productStock.aggregate({
          where: { organizationId, productId },
          _sum: { quantityOnHand: true },
        });
        await tx.product.update({
          where: { id: productId },
          data: { quantityOnHand: aggregate._sum.quantityOnHand ?? 0 },
        });
      } else {
        const updateResult = await tx.product.updateMany({
          where: {
            id: productId,
            organizationId,
            ...(delta < 0 ? { quantityOnHand: { gte: -delta } } : {}),
          },
          data: { quantityOnHand: { increment: delta } },
        });
        if (updateResult.count === 0) {
          throw new BadRequestException(
            `Insufficient stock: only ${product.quantityOnHand} unit(s) of "${product.name}" on hand`,
          );
        }
      }

      const movement = await tx.stockMovement.create({
        data: {
          organizationId,
          productId,
          branchId: effectiveBranchId,
          type: dto.type,
          quantity: delta,
          unitCost: dto.unitCost ?? Number(product.costPrice ?? 0),
          totalCost: Math.abs(delta) * (dto.unitCost ?? Number(product.costPrice ?? 0)),
          note: dto.note,
          recordedByUserId,
        },
      });
      const updatedProduct = await tx.product.findUniqueOrThrow({ where: { id: productId } });
      return { movement, updatedProduct };
    });

    const wasAboveThreshold = product.quantityOnHand > result.updatedProduct.reorderLevel;
    const isAtOrBelowNow = result.updatedProduct.quantityOnHand <= result.updatedProduct.reorderLevel;
    if (wasAboveThreshold && isAtOrBelowNow) {
      const payload: InventoryLowEvent = {
        organizationId,
        productId: result.updatedProduct.id,
        sku: result.updatedProduct.sku,
        name: result.updatedProduct.name,
        quantityOnHand: result.updatedProduct.quantityOnHand,
        reorderLevel: result.updatedProduct.reorderLevel,
      };
      this.events.emit(DomainEvent.InventoryLow, payload);
    }
    return result.movement;
  }
}
