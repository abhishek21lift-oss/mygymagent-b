/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < attempts
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new BadRequestException('Inventory operation could not be completed safely; please retry');
  }

  private number(prefix: string) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
    return `${prefix}-${stamp}-${randomUUID().slice(0, 6).toUpperCase()}`;
  }

  private async assertBranch(organizationId: string, branchId?: string | null) {
    if (!branchId) return;
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, organizationId } });
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private assertBranchScope(branchId: string | null | undefined, branchScope: string | null) {
    if (branchScope && branchId && branchId !== branchScope) {
      throw new ForbiddenException('Inventory access is restricted to the assigned branch');
    }
    return branchId ?? branchScope ?? undefined;
  }

  private page(query: InventoryQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    return { skip: (page - 1) * limit, take: limit };
  }

  private assertTransferScope(fromBranchId: string, toBranchId: string, branchScope: string | null) {
    if (branchScope && fromBranchId !== branchScope && toBranchId !== branchScope) {
      throw new ForbiddenException('Inventory transfer must involve your assigned branch');
    }
  }

  private async assertProducts(organizationId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const products = await this.prisma.product.findMany({ where: { organizationId, id: { in: unique }, isActive: true } });
    if (products.length !== unique.length) {
      throw new NotFoundException('One or more products do not belong to this organization or are inactive');
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
      unitCost?: number | Prisma.Decimal;
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

      const aggregate = await tx.productStock.aggregate({
        where: { organizationId, productId },
        _sum: { quantityOnHand: true },
      });
      await tx.product.update({
        where: { id: productId },
        data: { quantityOnHand: aggregate._sum.quantityOnHand ?? 0 },
      });
    }

    if (movement) {
      const unitCost = movement.unitCost ?? new Prisma.Decimal(product.costPrice ?? 0);
      await tx.stockMovement.create({
        data: {
          organizationId,
          productId,
          branchId: branchId ?? null,
          type: movement.type,
          quantity: delta,
          unitCost,
          totalCost: new Prisma.Decimal(Math.abs(delta)).mul(unitCost),
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
      ...this.page(query),
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

  async listPurchaseOrders(organizationId: string, query: InventoryQueryDto, branchScope: string | null = null) {
    return this.prisma.inventoryPurchaseOrder.findMany({
      where: {
        organizationId,
        ...(this.assertBranchScope(query.branchId, branchScope) ? { branchId: this.assertBranchScope(query.branchId, branchScope) } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      include: { supplier: true, items: true },
      orderBy: { createdAt: 'desc' },
      ...this.page(query),
    });
  }

  async createPurchaseOrder(organizationId: string, dto: CreatePurchaseOrderDto, branchScope: string | null = null) {
    if (!dto.items?.length) throw new BadRequestException('Purchase order must contain at least one item');
    const branchId = this.assertBranchScope(dto.branchId, branchScope);
    await this.assertBranch(organizationId, branchId);
    const supplier = await this.prisma.inventorySupplier.findFirst({ where: { id: dto.supplierId, organizationId, isActive: true } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const ids = dto.items.map((item) => item.productId);
    await this.assertProducts(organizationId, ids);
    const items = dto.items.map((item) => ({
      productId: item.productId,
      orderedQuantity: item.orderedQuantity,
      unitCost: new Prisma.Decimal(item.unitCost),
    }));
    const totalCost = items.reduce(
      (sum, item) => sum.add(new Prisma.Decimal(item.orderedQuantity).mul(item.unitCost)),
      new Prisma.Decimal(0),
    );
    return this.prisma.inventoryPurchaseOrder.create({
      data: {
        organizationId,
        supplierId: dto.supplierId,
        branchId,
        number: this.number('PO'),
        status: 'ORDERED',
        notes: dto.notes,
        expectedAt: dto.expectedAt,
        orderedAt: new Date(),
        totalCost,
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
    branchScope: string | null = null,
  ) {
    return this.serializable(async (tx) => {
      const po = await tx.inventoryPurchaseOrder.findFirst({
        where: { id, organizationId },
        include: { items: true },
      });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (po.status === 'CANCELLED' || po.status === 'RECEIVED') {
        throw new BadRequestException('Purchase order cannot be received in its current status');
      }

      if (po.branchId && dto.branchId && dto.branchId !== po.branchId) {
        throw new ForbiddenException('A purchase order must be received into its assigned branch');
      }
      const branchId = this.assertBranchScope(dto.branchId ?? po.branchId, branchScope);
      await this.assertBranch(organizationId, branchId);

      const requested = new Map(dto.items.map((item) => [item.productId, item.quantity]));
      const validIds = po.items.map((item) => item.productId);
      for (const productId of requested.keys()) {
        if (!validIds.includes(productId)) {
          throw new BadRequestException(`Product ${productId} is not on this purchase order`);
        }
      }

      for (const item of po.items) {
        const quantity = requested.get(item.productId) ?? 0;
        if (quantity === 0) continue;
        const remaining = item.orderedQuantity - item.receivedQuantity;
        if (quantity > remaining) {
          throw new BadRequestException(
            `Cannot receive more than the remaining quantity for product ${item.productId}`,
          );
        }
        await this.applyDelta(tx, organizationId, item.productId, quantity, branchId, {
          type: StockMovementType.RESTOCK,
          recordedByUserId,
          unitCost: item.unitCost,
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
      const allReceived = refreshed.items.every(
        (item) => item.receivedQuantity >= item.orderedQuantity,
      );
      const anyReceived = refreshed.items.some((item) => item.receivedQuantity > 0);

      return tx.inventoryPurchaseOrder.update({
        where: { id: po.id },
        data: {
          status: allReceived
            ? 'RECEIVED'
            : anyReceived
              ? 'PARTIALLY_RECEIVED'
              : 'ORDERED',
          receivedAt: allReceived ? new Date() : null,
        },
        include: { supplier: true, items: true },
      });
    });
  }

  async listTransfers(organizationId: string, query: InventoryQueryDto, branchScope: string | null = null) {
    return this.prisma.inventoryTransfer.findMany({
      where: {
        organizationId,
        ...(query.status ? { status: query.status as never } : {}),
        ...(branchScope ? { OR: [{ fromBranchId: branchScope }, { toBranchId: branchScope }] } : query.branchId ? { OR: [{ fromBranchId: query.branchId }, { toBranchId: query.branchId }] } : {}),
      },
      include: { fromBranch: true, toBranch: true, items: true },
      orderBy: { createdAt: 'desc' },
      ...this.page(query),
    });
  }

  async createTransfer(organizationId: string, dto: CreateInventoryTransferDto, branchScope: string | null = null) {
    if (dto.fromBranchId === dto.toBranchId) throw new BadRequestException('Source and destination branches must differ');
    if (!dto.items?.length) throw new BadRequestException('Transfer must contain at least one item');
    this.assertTransferScope(dto.fromBranchId, dto.toBranchId, branchScope);
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

  async shipTransfer(
    organizationId: string,
    id: string,
    recordedByUserId: string,
    branchScope: string | null = null,
  ) {
    return this.serializable(async (tx) => {
      const transfer = await tx.inventoryTransfer.findFirst({
        where: { id, organizationId },
        include: { items: true },
      });
      if (!transfer) throw new NotFoundException('Transfer not found');
      if (transfer.status !== 'DRAFT') {
        throw new BadRequestException('Only draft transfers can be shipped');
      }

      this.assertTransferScope(transfer.fromBranchId, transfer.toBranchId, branchScope);
      if (branchScope && transfer.fromBranchId !== branchScope) {
        throw new ForbiddenException('Only the source branch can ship this transfer');
      }

      for (const item of transfer.items) {
        await this.applyDelta(
          tx,
          organizationId,
          item.productId,
          -item.quantity,
          transfer.fromBranchId,
          {
            type: StockMovementType.TRANSFER_OUT,
            recordedByUserId,
            referenceType: 'TRANSFER',
            referenceId: transfer.id,
            note: `Shipped ${transfer.number}`,
          },
        );
      }

      return tx.inventoryTransfer.update({
        where: { id },
        data: { status: 'IN_TRANSIT', shippedAt: new Date() },
        include: { items: true, fromBranch: true, toBranch: true },
      });
    });
  }

  async receiveTransfer(
    organizationId: string,
    id: string,
    recordedByUserId: string,
    branchScope: string | null = null,
  ) {
    return this.serializable(async (tx) => {
      const transfer = await tx.inventoryTransfer.findFirst({
        where: { id, organizationId },
        include: { items: true },
      });
      if (!transfer) throw new NotFoundException('Transfer not found');
      if (transfer.status !== 'IN_TRANSIT') {
        throw new BadRequestException('Only in-transit transfers can be received');
      }

      this.assertTransferScope(transfer.fromBranchId, transfer.toBranchId, branchScope);
      if (branchScope && transfer.toBranchId !== branchScope) {
        throw new ForbiddenException('Only the destination branch can receive this transfer');
      }

      for (const item of transfer.items) {
        await this.applyDelta(
          tx,
          organizationId,
          item.productId,
          item.quantity,
          transfer.toBranchId,
          {
            type: StockMovementType.TRANSFER_IN,
            recordedByUserId,
            referenceType: 'TRANSFER',
            referenceId: transfer.id,
            note: `Received ${transfer.number}`,
          },
        );
      }

      return tx.inventoryTransfer.update({
        where: { id },
        data: { status: 'RECEIVED', receivedAt: new Date() },
        include: { items: true, fromBranch: true, toBranch: true },
      });
    });
  }

  async listSales(organizationId: string, query: InventoryQueryDto, branchScope: string | null = null) {
    return this.prisma.inventorySale.findMany({
      where: {
        organizationId,
        ...(this.assertBranchScope(query.branchId, branchScope) ? { branchId: this.assertBranchScope(query.branchId, branchScope) } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      ...this.page(query),
    });
  }

  async createSale(organizationId: string, dto: CreateInventorySaleDto, recordedByUserId: string, branchScope: string | null = null) {
    if (!dto.items?.length) throw new BadRequestException('Sale must contain at least one item');
    const branchId = this.assertBranchScope(dto.branchId, branchScope);
    await this.assertBranch(organizationId, branchId);
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
    const subtotal = dto.items.reduce(
      (sum, item) => sum.add(new Prisma.Decimal(item.quantity).mul(item.unitPrice)),
      new Prisma.Decimal(0),
    );
    const discount = new Prisma.Decimal(dto.discount ?? 0);
    if (discount.gt(subtotal)) throw new BadRequestException('Discount cannot exceed subtotal');
    const total = subtotal.sub(discount);

    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.inventorySale.create({
        data: {
          organizationId,
          branchId,
          memberId: dto.memberId,
          invoiceId: dto.invoiceId,
          createdByUserId: recordedByUserId,
          number: this.number('SALE'),
          subtotal,
          discount,
          total,
          currency: dto.currency ?? 'USD',
          items: {
            create: dto.items.map((item) => {
              const product = byId.get(item.productId)!;
              return {
                productId: item.productId,
                quantity: item.quantity,
                unitPrice: new Prisma.Decimal(item.unitPrice),
                unitCost: new Prisma.Decimal(product.costPrice ?? 0),
                total: new Prisma.Decimal(item.quantity).mul(item.unitPrice),
              };
            }),
          },
        },
        include: { items: true },
      });

      for (const item of dto.items) {
        const product = byId.get(item.productId)!;
        await this.applyDelta(tx, organizationId, item.productId, -item.quantity, branchId, {
          type: StockMovementType.SALE,
          recordedByUserId,
          unitCost: product.costPrice ?? new Prisma.Decimal(0),
          referenceType: 'SALE',
          referenceId: sale.id,
          note: `Sale ${sale.number}`,
        });
      }
      return sale;
    });
  }

  async returnSale(
    organizationId: string,
    id: string,
    dto: { items?: Array<{ productId: string; quantity: number }> } = {},
    recordedByUserId: string,
    branchScope: string | null = null,
  ) {
    return this.serializable(async (tx) => {
      const sale = await tx.inventorySale.findFirst({
        where: { id, organizationId },
        include: { items: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status !== 'COMPLETED' && sale.status !== 'PARTIALLY_RETURNED') {
        throw new BadRequestException('Only active completed sales can be returned');
      }
      this.assertBranchScope(sale.branchId, branchScope);

      const requested = dto.items?.length
        ? new Map(dto.items.map((item) => [item.productId, item.quantity]))
        : new Map(sale.items.map((item) => [item.productId, item.quantity - item.returnedQuantity]));

      for (const item of sale.items) {
        const quantity = requested.get(item.productId) ?? 0;
        if (quantity === 0) continue;
        const remaining = item.quantity - item.returnedQuantity;
        if (quantity > remaining) {
          throw new BadRequestException(`Cannot return more than the remaining quantity for product ${item.productId}`);
        }
        await this.applyDelta(tx, organizationId, item.productId, quantity, sale.branchId, {
          type: StockMovementType.RETURN,
          recordedByUserId,
          unitCost: item.unitCost,
          referenceType: 'SALE_RETURN',
          referenceId: sale.id,
          note: `Return of ${sale.number}`,
        });
        await tx.inventorySaleItem.update({
          where: { id: item.id },
          data: { returnedQuantity: { increment: quantity } },
        });
      }

      const refreshed = await tx.inventorySale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true },
      });
      const fullyReturned = refreshed.items.every((item) => item.returnedQuantity >= item.quantity);
      const anyReturned = refreshed.items.some((item) => item.returnedQuantity > 0);

      return tx.inventorySale.update({
        where: { id: sale.id },
        data: { status: fullyReturned ? 'RETURNED' : anyReturned ? 'PARTIALLY_RETURNED' : 'COMPLETED' },
        include: { items: true },
      });
    });
  }

  async cancelPurchaseOrder(organizationId: string, id: string, branchScope: string | null = null) {
    return this.serializable(async (tx) => {
      const po = await tx.inventoryPurchaseOrder.findFirst({ where: { id, organizationId }, include: { items: true } });
      if (!po) throw new NotFoundException('Purchase order not found');
      this.assertBranchScope(po.branchId, branchScope);
      if (!['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
        throw new BadRequestException('Purchase order cannot be cancelled in its current status');
      }
      return tx.inventoryPurchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' }, include: { supplier: true, items: true } });
    });
  }

  async cancelTransfer(organizationId: string, id: string, recordedByUserId: string, branchScope: string | null = null) {
    return this.serializable(async (tx) => {
      const transfer = await tx.inventoryTransfer.findFirst({ where: { id, organizationId }, include: { items: true } });
      if (!transfer) throw new NotFoundException('Transfer not found');
      this.assertTransferScope(transfer.fromBranchId, transfer.toBranchId, branchScope);
      if (transfer.status === 'DRAFT') {
        return tx.inventoryTransfer.update({ where: { id }, data: { status: 'CANCELLED' }, include: { items: true, fromBranch: true, toBranch: true } });
      }
      if (transfer.status !== 'IN_TRANSIT') {
        throw new BadRequestException('Transfer cannot be cancelled in its current status');
      }
      if (branchScope && transfer.fromBranchId !== branchScope) {
        throw new ForbiddenException('Only the source branch can cancel an in-transit transfer');
      }
      for (const item of transfer.items) {
        await this.applyDelta(tx, organizationId, item.productId, item.quantity, transfer.fromBranchId, {
          type: StockMovementType.RETURN,
          recordedByUserId,
          referenceType: 'TRANSFER_CANCEL',
          referenceId: transfer.id,
          note: `Cancelled ${transfer.number}`,
        });
      }
      return tx.inventoryTransfer.update({ where: { id }, data: { status: 'CANCELLED' }, include: { items: true, fromBranch: true, toBranch: true } });
    });
  }

  async cancelSale(organizationId: string, id: string, recordedByUserId: string, branchScope: string | null = null) {
    return this.serializable(async (tx) => {
      const sale = await tx.inventorySale.findFirst({ where: { id, organizationId }, include: { items: true } });
      if (!sale) throw new NotFoundException('Sale not found');
      this.assertBranchScope(sale.branchId, branchScope);
      if (sale.status !== 'COMPLETED' && sale.status !== 'PARTIALLY_RETURNED') {
        throw new BadRequestException('Sale cannot be cancelled in its current status');
      }
      for (const item of sale.items) {
        const remaining = item.quantity - item.returnedQuantity;
        if (remaining > 0) {
          await this.applyDelta(tx, organizationId, item.productId, remaining, sale.branchId, {
            type: StockMovementType.RETURN,
            recordedByUserId,
            unitCost: item.unitCost,
            referenceType: 'SALE_CANCEL',
            referenceId: sale.id,
            note: `Cancelled ${sale.number}`,
          });
          await tx.inventorySaleItem.update({ where: { id: item.id }, data: { returnedQuantity: item.quantity } });
        }
      }
      return tx.inventorySale.update({ where: { id }, data: { status: 'CANCELLED' }, include: { items: true } });
    });
  }

  async branchStock(organizationId: string, query: InventoryQueryDto, branchScope: string | null = null) {
    const branchId = this.assertBranchScope(query.branchId, branchScope);
    await this.assertBranch(organizationId, branchId);
    return this.prisma.productStock.findMany({
      where: {
        organizationId,
        ...(branchId ? { branchId } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
      },
      include: { product: true, branch: true },
      orderBy: { updatedAt: 'desc' },
      ...this.page(query),
    });
  }

  async reorderSuggestions(organizationId: string, branchId?: string, branchScope: string | null = null) {
    branchId = this.assertBranchScope(branchId, branchScope);
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

  async dashboard(organizationId: string, branchScope: string | null = null) {
    const [stockRows, suppliers, openOrders, inTransit, sales] = await Promise.all([
      branchScope
        ? this.prisma.productStock.findMany({
            where: {
              organizationId,
              branchId: branchScope,
              product: { isActive: true },
            },
            select: {
              quantityOnHand: true,
              product: {
                select: {
                  id: true,
                  reorderLevel: true,
                  costPrice: true,
                },
              },
            },
          }).then(rows => rows.map(r => ({
            quantityOnHand: r.quantityOnHand,
            product: r.product,
          })))
        : this.prisma.product.findMany({
            where: { organizationId, isActive: true },
            select: {
              id: true,
              quantityOnHand: true,
              reorderLevel: true,
              costPrice: true,
            },
          }).then(rows => rows.map(p => ({
            quantityOnHand: p.quantityOnHand,
            product: p,
          }))),
      this.prisma.inventorySupplier.count({
        where: { organizationId, isActive: true },
      }),
      this.prisma.inventoryPurchaseOrder.count({
        where: {
          organizationId,
          status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] },
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      }),
      this.prisma.inventoryTransfer.count({
        where: {
          organizationId,
          status: 'IN_TRANSIT',
          ...(branchScope
            ? { OR: [{ fromBranchId: branchScope }, { toBranchId: branchScope }] }
            : {}),
        },
      }),
      this.prisma.inventorySale.aggregate({
        where: {
          organizationId,
          status: 'COMPLETED',
          ...(branchScope ? { branchId: branchScope } : {}),
        },
        _sum: { total: true },
      }),
    ]);

    const lowStock = stockRows.filter(
      (row) => row.quantityOnHand <= row.product.reorderLevel,
    ).length;
    const units = stockRows.reduce(
      (sum, row) => sum + row.quantityOnHand,
      0,
    );
    const valuation = stockRows.reduce(
      (sum, row) => sum.add(
        new Prisma.Decimal(row.quantityOnHand).mul(row.product.costPrice ?? 0),
      ),
      new Prisma.Decimal(0),
    );

    return {
      activeProducts: stockRows.length,
      lowStockProducts: lowStock,
      totalUnits: units,
      inventoryCostValue: valuation.toNumber(),
      activeSuppliers: suppliers,
      openPurchaseOrders: openOrders,
      transfersInTransit: inTransit,
      salesTotal: Number(sales._sum.total ?? 0),
    };
  }
}
