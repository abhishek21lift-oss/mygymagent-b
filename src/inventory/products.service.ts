import { Injectable, NotFoundException } from '@nestjs/common';
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

  // Duplicate SKUs within an org are rejected by the DB's unique
  // constraint (organizationId, sku) -> AllExceptionsFilter maps the
  // resulting P2002 to a 409, same convention as every other module here.
  create(organizationId: string, dto: CreateProductDto) {
    return this.prisma.product.create({
      data: { organizationId, ...dto },
    });
  }

  async update(organizationId: string, id: string, dto: UpdateProductDto) {
    await this.getOne(organizationId, id);
    return this.prisma.product.update({ where: { id }, data: dto });
  }
}
