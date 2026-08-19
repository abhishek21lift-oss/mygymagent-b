import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateBranchDto } from './dto/create-branch.dto';
import type { UpdateBranchDto } from './dto/update-branch.dto';

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: PaginationQueryDto) {
    const where = {
      organizationId,
      deletedAt: null,
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.branch.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
      }),
      this.prisma.branch.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    // Scoping by organizationId in the same query means a branch id from a
    // different tenant simply doesn't match -- no separate ownership check
    // needed, and no distinguishable 403 vs 404 that could leak existence.
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async create(organizationId: string, dto: CreateBranchDto) {
    return this.prisma.branch.create({ data: { ...dto, organizationId } });
  }

  async update(organizationId: string, id: string, dto: UpdateBranchDto) {
    await this.getOne(organizationId, id);
    return this.prisma.branch.update({ where: { id }, data: dto });
  }

  async remove(organizationId: string, id: string) {
    await this.getOne(organizationId, id);
    return this.prisma.branch.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });
  }
}
