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

  /**
   * A plan with no `currency` takes the organization's, not the schema's
   * `@default("USD")`.
   *
   * The DTO has always accepted `currency` and the plan form has never
   * sent one, so every plan created through the UI landed on the column
   * default. 619 Fitness Studio is an INR organization whose three
   * plans were therefore all stored as USD -- 2000 rupees recorded as
   * two thousand dollars -- and `Membership.currency` is copied from the
   * plan at sale, so each sale propagated it. Payments, which do read
   * the organization, were being written INR against USD memberships.
   */
  async create(organizationId: string, dto: CreateMembershipPlanDto) {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });
    return this.prisma.membershipPlan.create({
      data: {
        ...dto,
        organizationId,
        currency: dto.currency ?? organization.currency,
      },
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
