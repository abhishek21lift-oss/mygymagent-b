/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateInventorySaleDto, CreateInventorySupplierDto, CreateInventoryTransferDto,
  CreatePurchaseOrderDto, InventoryQueryDto, ReceivePurchaseOrderDto,
  UpdateInventorySupplierDto,
} from './dto/complete-inventory.dto';

@Injectable()
export class CompleteInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  private number(prefix: string) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
    return `${prefix}-${stamp}-${randomUUID().slice(0, 6).toUpperCase()}`;
  }

  private async assertBranch(organizationId: string, branchId?: string | null) {
    if (!branchId) return;
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, organizationId } });
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private async assertProducts(organizationId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const products = await this.prisma.product.findMany({ where: { organizationId, id: { in: unique } } });
    if (products.length !== unique.length) {
      throw new NotFoundException('One or more products do not belong to this organization');
    }
    return products;
  }

  private async applyDelta(
    tx: Prisma.TransactionClient,
    organizationId: string,
    productId: string,
    delta: number,
    branchId?: string | null,
    movement?: {
      type: StockMovementType;
      recordedByUserId?: string;
      unitCost?: number;
      referenceType?: string;
      referenceId?: string;
      note?: string;
    },
  ) {
    const product = await tx.product.findFirst({ where: { id: productId, organizationId } });
    if (!product) throw new NotFoundException('Product not found');

    if (branchId) {
      await tx.productStock.upsert({
        where: { organizationId_branchId_productId: { organizationId, branchId, productId } },
        create: { organizationId, branchId, productId, quantityOnHand: 0 },
        update: {},
      });
    }

    const totalResult = await tx.product.updateMany({
      where: { id: productId, organizationId, ...(delta < 0 ? { quantityOnHand: { gte: -delta } } : {}) },
      data: { quantityOnHand: { increment: delta } },
    });
    if (totalResult.count !== 1) {
      throw new BadRequestException(
        `Insufficient stock: only ${product.quantityOnHand} unit(s) of "${product.name}" on hand`,
      );
    }

    if (branchId) {
      const branchResult = await tx.productStock.updateMany({
        where: {
          organizationId,
          branchId,
          productId,
          ...(delta < 0 ? { quantityOnHand: { gte: -delta } } : {}),
        },
        data: { quantityOnHand: { increment: delta } },
      });
      if (branchResult.count !== 1) {
        throw new BadRequestException(
          `Insufficient branch stock for "${product.name}"`,
        );
      }
    }

    if (movement) {
      const unitCost = movement.unitCost ?? Number(product.costPrice ?? 0);
      await tx.stockMovement.create({
        data: {
          organizationId,
          productId,
          branchId: branchId ?? null,
          type: movement.type,
          quantity: delta,
          unitCost,
          totalCost: Math.abs(delta) * unitCost,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          note: movement.note,
          recordedByUserId: movement.recordedByUserId,
        },
      });
    }
  }

  async listSuppliers(organizationId: string, query: InventoryQueryDto) {
    return this.prisma.inventorySupplier.findMany({
      where: {
        organizationId,
        ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
        ...(query.activeOnly ? { isActive: true } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
  }

  async createSupplier(organizationId: string, dto: CreateInventorySupplierDto) {
    return this.prisma.inventorySupplier.create({ data: { organizationId, ...dto } });
  }

  async updateSupplier(organizationId: string, id: string, dto: UpdateInventorySupplierDto) {
    const supplier = await this.prisma.inventorySupplier.findFirst({ where: { id, organizationId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return this.prisma.inventorySupplier.update({ where: { id }, data: dto });
  }

  async listPurchaseOrders(organizationId: string, query: InventoryQueryDto) {
    return this.prisma.inventoryPurchaseOrder.findMany({
      where: {
        organizationId,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      include: { supplier: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createPurchaseOrder(organizationId: string, dto: CreatePurchaseOrderDto) {
    if (!dto.items?.length) throw new BadRequestException('Purchase order must contain at least one item');
    await this.assertBranch(organizationId, dto.branchId);
    const supplier = await this.prisma.inventorySupplier.findFirst({ where: { id: dto.supplierId, organizationId, isActive: true } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const ids = dto.items.map((item) => item.productId);
    await this.assertProducts(organizationId, ids);
    const items = dto.items.map((item) => ({
      productId: item.productId,
      orderedQuantity: item.orderedQuantity,
      unitCost: new Prisma.Decimal(item.unitCost),
    }));
    const totalCost = items.reduce((sum, item) => sum + item.orderedQuantity * Number(item.unitCost), 0);
    return this.prisma.inventoryPurchaseOrder.create({
      data: {
        organizationId,
        supplierId: dto.supplierId,
        branchId: dto.branchId,
        number: this.number('PO'),
        status: 'ORDERED',
        notes: dto.notes,
        expectedAt: dto.expectedAt,
        orderedAt: new Date(),
        totalCost: new Prisma.Decimal(totalCost),
        items: { create: items },
      },
      include: { supplier: true, items: true },
    });
  }

  async receivePurchaseOrder(
    organizationId: string,
    id: string,
    dto: ReceivePurchaseOrderDto,
    recordedByUserId: string,
  ) {
    const po = await this.prisma.inventoryPurchaseOrder.findFirst({ where: { id, organizationId }, include: { items: true } });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status === 'CANCELLED' || po.status === 'RECEIVED') throw new BadRequestException('Purchase order cannot be received in its current status');
    const branchId = dto.branchId ?? po.branchId;
    await this.assertBranch(organizationId, branchId);
    const requested = new Map(dto.items.map((item) => [item.productId, item.quantity]));
    const validIds = po.items.map((item) => item.productId);
    for (const productId of requested.keys()) {
      if (!validIds.includes(productId)) throw new BadRequestException(`Product ${productId} is not on this purchase order`);
    }

    return this.prisma.$transaction(async (tx) => {
      for (const item of po.items) {
        const quantity = requested.get(item.productId) ?? 0;
        if (quantity === 0) continue;
        const remaining = item.orderedQuantity - item.receivedQuantity;
        if (quantity > remaining) throw new BadRequestException(`Cannot receive more than the remaining quantity for product ${item.productId}`);
        await this.applyDelta(tx, organizationId, item.productId, quantity, branchId, {
          type: StockMovementType.RESTOCK,
          recordedByUserId,
          unitCost: Number(item.unitCost),
          referenceType: 'PURCHASE_ORDER',
          referenceId: po.id,
          note: `Received against ${po.number}`,
        });
        await tx.inventoryPurchaseOrderItem.update({
          where: { id: item.id },
          data: { receivedQuantity: { increment: quantity } },
        });
      }
      const refreshed = await tx.inventoryPurchaseOrder.findUniqueOrThrow({
        where: { id: po.id },
        include: { items: true },
      });
      const allReceived = refreshed.items.every((item) => item.receivedQuantity >= item.orderedQuantity);
      const anyReceived = refreshed.items.some((item) => item.receivedQuantity > 0);
      return tx.inventoryPurchaseOrder.update({
        where: { id: po.id },
        data: {
          status: allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'ORDERED',
          receivedAt: allReceived ? new Date() : null,
        },
        include: { supplier: true, items: true },
      });
    });
  }

  async listTransfers(organizationId: string, query: InventoryQueryDto) {
    return this.prisma.inventoryTransfer.findMany({
      where: {
        organizationId,
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.branchId ? { OR: [{ fromBranchId: query.branchId }, { toBranchId: query.branchId }] } : {}),
      },
      include: { fromBranch: true, toBranch: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createTransfer(organizationId: string, dto: CreateInventoryTransferDto) {
    if (dto.fromBranchId === dto.toBranchId) throw new BadRequestException('Source and destination branches must differ');
    if (!dto.items?.length) throw new BadRequestException('Transfer must contain at least one item');
    await this.assertBranch(organizationId, dto.fromBranchId);
    await this.assertBranch(organizationId, dto.toBranchId);
    await this.assertProducts(organizationId, dto.items.map((item) => item.productId));
    return this.prisma.inventoryTransfer.create({
      data: {
        organizationId,
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        number: this.number('TR'),
        notes: dto.notes,
        items: { create: dto.items },
      },
      include: { items: true, fromBranch: true, toBranch: true },
    });
  }

  async shipTransfer(organizationId: string, id: string, recordedByUserId: string) {
    const transfer = await this.prisma.inventoryTransfer.findFirst({ where: { id, organizationId }, include: { items: true } });
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status !== 'DRAFT') throw new BadRequestException('Only draft transfers can be shipped');
    return this.prisma.$transaction(async (tx) => {
      for (const item of transfer.items) {
        await this.applyDelta(tx, organizationId, item.productId, -item.quantity, transfer.fromBranchId, {
          type: StockMovementType.TRANSFER_OUT,
          recordedByUserId,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          note: `Shipped ${transfer.number}`,
        });
      }
      return tx.inventoryTransfer.update({
        where: { id },
        data: { status: 'IN_TRANSIT', shippedAt: new Date() },
        include: { items: true, fromBranch: true, toBranch: true },
      });
    });
  }

  async receiveTransfer(organizationId: string, id: string, recordedByUserId: string) {
    const transfer = await this.prisma.inventoryTransfer.findFirst({ where: { id, organizationId }, include: { items: true } });
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status !== 'IN_TRANSIT') throw new BadRequestException('Only in-transit transfers can be received');
    return this.prisma.$transaction(async (tx) => {
      for (const item of transfer.items) {
        await this.applyDelta(tx, organizationId, item.productId, item.quantity, transfer.toBranchId, {
          type: StockMovementType.TRANSFER_IN,
          recordedByUserId,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          note: `Received ${transfer.number}`,
        });
      }
      return tx.inventoryTransfer.update({
        where: { id },
        data: { status: 'RECEIVED', receivedAt: new Date() },
        include: { items: true, fromBranch: true, toBranch: true },
      });
    });
  }

  async listSales(organizationId: string, query: InventoryQueryDto) {
    return this.prisma.inventorySale.findMany({
      where: {
        organizationId,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createSale(organizationId: string, dto: CreateInventorySaleDto, recordedByUserId: string) {
    if (!dto.items?.length) throw new BadRequestException('Sale must contain at least one item');
    await this.assertBranch(organizationId, dto.branchId);
    if (dto.memberId) {
      const member = await this.prisma.member.findFirst({ where: { id: dto.memberId, organizationId } });
      if (!member) throw new NotFoundException('Member not found');
    }
    if (dto.invoiceId) {
      const invoice = await this.prisma.invoice.findFirst({ where: { id: dto.invoiceId, organizationId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
    }
    const products = await this.assertProducts(organizationId, dto.items.map((item) => item.productId));
    const byId = new Map(products.map((product) => [product.id, product]));
    const subtotal = dto.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const discount = dto.discount ?? 0;
    if (discount > subtotal) throw new BadRequestException('Discount cannot exceed subtotal');
    const total = subtotal - discount;

    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.inventorySale.create({
        data: {
          organizationId,
          branchId: dto.branchId,
          memberId: dto.memberId,
          invoiceId: dto.invoiceId,
          createdByUserId: recordedByUserId,
          number: this.number('SALE'),
          subtotal: new Prisma.Decimal(subtotal),
          discount: new Prisma.Decimal(discount),
          total: new Prisma.Decimal(total),
          currency: dto.currency ?? 'USD',
          items: {
            create: dto.items.map((item) => {
              const product = byId.get(item.productId)!;
              return {
                productId: item.productId,
                quantity: item.quantity,
                unitPrice: new Prisma.Decimal(item.unitPrice),
                unitCost: new Prisma.Decimal(Number(product.costPrice ?? 0)),
                total: new Prisma.Decimal(item.quantity * item.unitPrice),
              };
            }),
          },
        },
        include: { items: true },
      });

      for (const item of dto.items) {
        const product = byId.get(item.productId)!;
        await this.applyDelta(tx, organizationId, item.productId, -item.quantity, dto.branchId, {
          type: StockMovementType.SALE,
          recordedByUserId,
          unitCost: Number(product.costPrice ?? 0),
          referenceType: 'SALE',
          referenceId: sale.id,
          note: `Sale ${sale.number}`,
        });
      }
      return sale;
    });
  }

  async returnSale(organizationId: string, id: string, recordedByUserId: string) {
    const sale = await this.prisma.inventorySale.findFirst({ where: { id, organizationId }, include: { items: true } });
    if (!sale) throw new NotFoundException('Sale not found');
    if (sale.status !== 'COMPLETED') throw new BadRequestException('Only completed sales can be returned');
    return this.prisma.$transaction(async (tx) => {
      for (const item of sale.items) {
        await this.applyDelta(tx, organizationId, item.productId, item.quantity, sale.branchId, {
          type: StockMovementType.RETURN,
          recordedByUserId,
          unitCost: Number(item.unitCost),
          referenceType: 'SALE_RETURN',
          referenceId: sale.id,
          note: `Return of ${sale.number}`,
        });
      }
      return tx.inventorySale.update({
        where: { id },
        data: { status: 'RETURNED' },
        include: { items: true },
      });
    });
  }

  async branchStock(organizationId: string, query: InventoryQueryDto) {
    await this.assertBranch(organizationId, query.branchId);
    return this.prisma.productStock.findMany({
      where: {
        organizationId,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
      },
      include: { product: true, branch: true },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
  }

  async reorderSuggestions(organizationId: string, branchId?: string) {
    await this.assertBranch(organizationId, branchId);
    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
    });
    if (!branchId) {
      return products
        .filter((p) => p.quantityOnHand <= p.reorderLevel)
        .map((p) => ({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantityOnHand: p.quantityOnHand,
          reorderLevel: p.reorderLevel,
          suggestedQuantity: Math.max(p.reorderQuantity, p.reorderLevel - p.quantityOnHand),
        }));
    }
    const stocks = await this.prisma.productStock.findMany({ where: { organizationId, branchId } });
    const byProduct = new Map(stocks.map((s) => [s.productId, s.quantityOnHand]));
    return products
      .map((p) => ({ p, quantityOnHand: byProduct.get(p.id) ?? 0 }))
      .filter(({ p, quantityOnHand }) => quantityOnHand <= p.reorderLevel)
      .map(({ p, quantityOnHand }) => ({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        quantityOnHand,
        reorderLevel: p.reorderLevel,
        suggestedQuantity: Math.max(p.reorderQuantity, p.reorderLevel - quantityOnHand),
      }));
  }

  async dashboard(organizationId: string) {
    const [products, suppliers, openOrders, inTransit, sales] = await Promise.all([
      this.prisma.product.findMany({ where: { organizationId, isActive: true }, select: { id: true, quantityOnHand: true, reorderLevel: true, costPrice: true } }),
      this.prisma.inventorySupplier.count({ where: { organizationId, isActive: true } }),
      this.prisma.inventoryPurchaseOrder.count({ where: { organizationId, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } } }),
      this.prisma.inventoryTransfer.count({ where: { organizationId, status: 'IN_TRANSIT' } }),
      this.prisma.inventorySale.aggregate({ where: { organizationId, status: { in: ['COMPLETED', 'RETURNED'] } }, _sum: { total: true } }),
    ]);
    const lowStock = products.filter((p) => p.quantityOnHand <= p.reorderLevel).length;
    const units = products.reduce((sum, p) => sum + p.quantityOnHand, 0);
    const valuation = products.reduce((sum, p) => sum + p.quantityOnHand * Number(p.costPrice ?? 0), 0);
    return {
      activeProducts: products.length,
      lowStockProducts: lowStock,
      totalUnits: units,
      inventoryCostValue: valuation,
      activeSuppliers: suppliers,
      openPurchaseOrders: openOrders,
      transfersInTransit: inTransit,
      salesTotal: Number(sales._sum.total ?? 0),
    };
  }
}
