import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { ListFollowUpsQueryDto } from './dto/list-follow-ups-query.dto';

@Injectable()
export class FollowUpsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: ListFollowUpsQueryDto,
    branchScope: string | null = null,
  ) {
    const dueAt: Prisma.DateTimeFilter = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
    const where: Prisma.LeadFollowUpWhereInput = {
      organizationId,
      ...(branchScope ? { lead: { branchId: branchScope } } : {}),
      ...(query.status === 'OPEN' ? { completedAt: null } : {}),
      ...(query.status === 'COMPLETED' ? { completedAt: { not: null } } : {}),
      ...(query.from || query.to ? { dueAt } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.leadFollowUp.findMany({
        where,
        ...skipTake(query),
        orderBy: [{ completedAt: 'asc' }, { dueAt: 'asc' }],
        include: {
          lead: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
              source: true,
              status: true,
              assignedToUser: {
                select: { id: true, firstName: true, lastName: true },
              },
            },
          },
          createdByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.leadFollowUp.count({ where }),
    ]);

    return paginate(items, total, query.page, query.pageSize);
  }
}
