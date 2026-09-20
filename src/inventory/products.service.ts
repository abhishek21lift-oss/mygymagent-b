/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import type { CreateProductDto } from './dto/create-product.dto';
import type { ListProductsQueryDto } from './dto/list-products-query.dto';
import type { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: ListProductsQueryDto) {
    const where = {
      organizationId,
      ...(query.category ? { category: query.category } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              {
                name: { contains: query.search, mode: 'insensitive' as const },
              },
              { sku: { contains: query.search, mode: 'insensitive' as const } },
              {
                barcode: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        ...skipTake(query),
        orderBy: { name: 'asc' },
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, organizationId },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async getBySku(organizationId: string, code: string) {
    const value = code.trim();
    if (!value) throw new NotFoundException('Product not found');
    const product = await this.prisma.product.findFirst({
      where: {
        organizationId,
        OR: [{ sku: value }, { barcode: value }],
      },
    });
    if (!product)
      throw new NotFoundException(`No product found for code "${value}"`);
    return product;
  }

  async create(
    organizationId: string,
    dto: CreateProductDto,
    branchScope: string | null = null,
  ) {
    const quantity = dto.quantityOnHand ?? 0;
    const { quantityOnHand: _quantityOnHand, ...productData } = dto;
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          organizationId,
          ...productData,
          quantityOnHand: quantity,
          sku: dto.sku.trim(),
          barcode: dto.barcode?.trim() || undefined,
          unit: dto.unit?.trim() || 'unit',
        },
      });
      if (quantity > 0 && branchScope) {
        await tx.productStock.create({
          data: {
            organizationId,
            branchId: branchScope,
            productId: product.id,
            quantityOnHand: quantity,
          },
        });
      }
      if (quantity > 0) {
        await tx.stockMovement.create({
          data: {
            organizationId,
            productId: product.id,
            branchId: branchScope,
            type: StockMovementType.OPENING,
            quantity,
            unitCost: dto.costPrice ?? 0,
            totalCost: quantity * (dto.costPrice ?? 0),
            referenceType: 'OPENING_STOCK',
            referenceId: product.id,
            note: 'Opening stock at product creation',
          },
        });
      }
      return product;
    });
  }

  async update(organizationId: string, id: string, dto: UpdateProductDto) {
    await this.getOne(organizationId, id);
    return this.prisma.product.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.sku !== undefined ? { sku: dto.sku.trim() } : {}),
        ...(dto.barcode !== undefined
          ? { barcode: dto.barcode.trim() || null }
          : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit.trim() || 'unit' } : {}),
      },
    });
  }
}
