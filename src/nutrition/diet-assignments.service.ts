import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateDietAssignmentStatusDto } from './dto/update-diet-assignment-status.dto';

@Injectable()
export class DietAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
  ) {
    const where = { organizationId, ...(memberId ? { memberId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.dietAssignment.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          dietPlan: { select: { id: true, name: true } },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.dietAssignment.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async updateStatus(
    organizationId: string,
    id: string,
    dto: UpdateDietAssignmentStatusDto,
  ) {
    const assignment = await this.prisma.dietAssignment.findFirst({
      where: { id, organizationId },
    });
    if (!assignment) throw new NotFoundException('Diet assignment not found');

    return this.prisma.dietAssignment.update({
      where: { id },
      data: { status: dto.status },
    });
  }
}
