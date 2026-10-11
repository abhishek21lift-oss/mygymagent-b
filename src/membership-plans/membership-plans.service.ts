import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import {
  CreateMembershipPlanDto,
  isSupportedCurrency,
} from './dto/create-membership-plan.dto';
import type { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';

@Injectable()
export class MembershipPlansService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Branch-scoped callers see global plans plus their own branch's.
   * Organization-wide callers see everything in the tenant.
   */
  async list(
    organizationId: string,
    query: PaginationQueryDto,
    branchScope: string | null = null,
  ) {
    const where = {
      organizationId,
      ...(branchScope
        ? { OR: [{ branchId: null }, { branchId: branchScope }] }
        : {}),
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

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id, organizationId },
    });
    if (!plan) throw new NotFoundException('Membership plan not found');
    // A branch-scoped caller outside the plan's branch sees the same
    // not-found as a foreign id: scoped lookup, same convention as
    // branches themselves.
    if (branchScope && plan.branchId && plan.branchId !== branchScope) {
      throw new NotFoundException('Membership plan not found');
    }
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
  async create(
    organizationId: string,
    dto: CreateMembershipPlanDto,
    branchScope: string | null = null,
  ) {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });
    await this.assertBranchInTenant(organizationId, dto.branchId);
    if (branchScope && dto.branchId && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot create a plan outside your assigned branch',
      );
    }
    this.assertOfferPrice(dto.price, dto.compareAtPrice);
    this.assertCurrency(dto.currency);
    // Class instances do not satisfy Prisma's Json input type; store
    // plain objects.
    const { faqs, ...rest } = dto;
    return this.prisma.membershipPlan.create({
      data: {
        ...rest,
        faqs: faqs?.map((f) => ({ q: f.q, a: f.a })),
        organizationId,
        currency:
          dto.currency && dto.currency.trim()
            ? dto.currency
            : organization.currency,
      },
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateMembershipPlanDto,
    branchScope: string | null = null,
  ) {
    const before = await this.getOne(organizationId, id, branchScope);
    // Editing a global plan affects every branch: branch-scoped
    // callers may only touch their own branch's plans.
    if (branchScope && before.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot edit a plan outside your assigned branch',
      );
    }
    await this.assertBranchInTenant(organizationId, dto.branchId);
    if (branchScope && dto.branchId && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot move a plan outside your assigned branch',
      );
    }
    const price = dto.price ?? Number(before.price);
    this.assertOfferPrice(price, dto.compareAtPrice);
    // A blank currency keeps the stored value; only a real code is
    // validated and written.
    const { faqs, ...rest } = dto;
    const data: Prisma.MembershipPlanUpdateInput = {
      ...rest,
      ...(faqs !== undefined
        ? { faqs: faqs.map((f) => ({ q: f.q, a: f.a })) }
        : {}),
    };
    if (typeof data.currency === 'string' && data.currency.trim() === '') {
      delete data.currency;
    }
    if (data.currency !== undefined) {
      this.assertCurrency(data.currency as string);
    }
    return this.prisma.membershipPlan.update({ where: { id }, data });
  }

  /**
   * The was-price must genuinely exceed the list price; otherwise the
   * "offer" is a surcharge label. Types arrive as numbers via the DTO.
   */
  private assertOfferPrice(price: number, compareAtPrice?: number | null) {
    if (
      compareAtPrice !== undefined &&
      compareAtPrice !== null &&
      Number(compareAtPrice) <= Number(price)
    ) {
      throw new BadRequestException('compareAtPrice must exceed price');
    }
  }

  private assertCurrency(currency: string | undefined) {
    if (
      currency !== undefined &&
      currency !== '' &&
      !isSupportedCurrency(currency)
    ) {
      throw new BadRequestException(
        'currency must be a supported ISO-4217 code',
      );
    }
  }

  /**
   * A plan scoped to another tenant's branch would silently sell the wrong
   * location's inventory. Scoped lookup, same as branches themselves: a
   * foreign id simply doesn't match.
   */
  private async assertBranchInTenant(
    organizationId: string,
    branchId: string | undefined,
  ) {
    if (!branchId) return;
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
  }

  async remove(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const before = await this.getOne(organizationId, id, branchScope);
    if (branchScope && before.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot deactivate a plan outside your assigned branch',
      );
    }
    return this.prisma.membershipPlan.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
