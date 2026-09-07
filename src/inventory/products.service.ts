import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import type { CreateProductDto } from './dto/create-product.dto';
import type { ListProductsQueryDto } from './dto/list-products-query.dto';
import type { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normalizes a scanned barcode/QR value before SKU matching.
   * EAN-13/UPC-A codes with a leading zero can lose that zero when a
   * scanner (or the numeric-keyboard workflow some devices use) treats
   * the value as a number, producing a 12-digit string that no longer
   * equals the stored SKU. Try the exact value first, then the
   * zero-padded variant -- a deliberate best-effort convenience for
   * numeric codes only; SKUs stay matched exactly as typed. */
  private normalizeScanCode(code: string): string[] {
    const trimmed = code.trim();
    const candidates = [trimmed];
    if (/^\d{1,13}$/.test(trimmed)) {
      candidates.push(trimmed.padStart(13, '0'));
    }
    return candidates;
  }

  /** Resolves a scanned QR/barcode value to a product by exact SKU
   * match, within the caller's organization only -- a code only ever
   * resolves to this tenant's product, never another org's (the
   * organizationId + sku unique constraint guarantees one product per
   * code per org). */
  async findByScanCode(organizationId: string, code: string) {
    for (const candidate of this.normalizeScanCode(code)) {
      const product = await this.prisma.product.findFirst({
        where: { organizationId, sku: candidate },
      });
      if (product) return product;
    }
    throw new NotFoundException('No product with this code');
  }

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
