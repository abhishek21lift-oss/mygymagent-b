import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import type { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';

@Injectable()
export class MembershipPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: PaginationQueryDto) {
    const where = {
      organizationId,
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.membershipPlan.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
      }),
      this.prisma.membershipPlan.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id, organizationId },
    });
    if (!plan) throw new NotFoundException('Membership plan not found');
    return plan;
  }

  create(organizationId: string, dto: CreateMembershipPlanDto) {
    return this.prisma.membershipPlan.create({
      data: { ...dto, organizationId },
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateMembershipPlanDto,
  ) {
    await this.getOne(organizationId, id);
    return this.prisma.membershipPlan.update({ where: { id }, data: dto });
  }

  async remove(organizationId: string, id: string) {
    await this.getOne(organizationId, id);
    return this.prisma.membershipPlan.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
