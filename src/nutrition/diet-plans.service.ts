import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { DomainEvent, type DietAssignedEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { AssignDietPlanDto } from './dto/assign-diet-plan.dto';
import type { CreateDietPlanDto } from './dto/create-diet-plan.dto';
import type { UpdateDietPlanDto } from './dto/update-diet-plan.dto';

@Injectable()
export class DietPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(organizationId: string, query: PaginationQueryDto) {
    const where = { organizationId };
    const [items, total] = await Promise.all([
      this.prisma.dietPlan.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
      }),
      this.prisma.dietPlan.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    const plan = await this.prisma.dietPlan.findFirst({
      where: { id, organizationId },
    });
    if (!plan) throw new NotFoundException('Diet plan not found');
    return plan;
  }

  /** Every referenced foodItemId must belong to this organization -- same
   * tenant-isolation rule as WorkoutPlansService's exercise check. */
  private async assertFoodItemsBelongToOrg(
    organizationId: string,
    foodItemIds: string[],
  ): Promise<void> {
    if (foodItemIds.length === 0) return;
    const found = await this.prisma.foodItem.findMany({
      where: { organizationId, id: { in: foodItemIds } },
      select: { id: true },
    });
    if (found.length !== new Set(foodItemIds).size) {
      throw new BadRequestException(
        'One or more food items were not found in this organization',
      );
    }
  }

  async create(
    organizationId: string,
    dto: CreateDietPlanDto,
    createdByUserId: string,
  ) {
    await this.assertFoodItemsBelongToOrg(
      organizationId,
      dto.items.map((i) => i.foodItemId),
    );
    return this.prisma.dietPlan.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        items: dto.items as unknown as Prisma.InputJsonValue,
        targetCalories: dto.targetCalories,
        targetProteinG: dto.targetProteinG,
        targetCarbsG: dto.targetCarbsG,
        targetFatG: dto.targetFatG,
        createdByUserId,
      },
    });
  }

  async update(organizationId: string, id: string, dto: UpdateDietPlanDto) {
    await this.getOne(organizationId, id);
    if (dto.items) {
      await this.assertFoodItemsBelongToOrg(
        organizationId,
        dto.items.map((i) => i.foodItemId),
      );
    }
    return this.prisma.dietPlan.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.items !== undefined
          ? { items: dto.items as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.targetCalories !== undefined
          ? { targetCalories: dto.targetCalories }
          : {}),
        ...(dto.targetProteinG !== undefined
          ? { targetProteinG: dto.targetProteinG }
          : {}),
        ...(dto.targetCarbsG !== undefined
          ? { targetCarbsG: dto.targetCarbsG }
          : {}),
        ...(dto.targetFatG !== undefined ? { targetFatG: dto.targetFatG } : {}),
      },
    });
  }

  async assign(
    organizationId: string,
    dietPlanId: string,
    dto: AssignDietPlanDto,
    assignedByUserId: string,
  ) {
    const [plan, member] = await Promise.all([
      this.getOne(organizationId, dietPlanId),
      this.prisma.member.findFirst({
        where: { id: dto.memberId, organizationId, deletedAt: null },
      }),
    ]);
    if (!member) throw new NotFoundException('Member not found');

    const assignment = await this.prisma.dietAssignment.create({
      data: {
        organizationId,
        dietPlanId: plan.id,
        memberId: member.id,
        assignedByUserId,
        startDate: dto.startDate ? new Date(dto.startDate) : new Date(),
        notes: dto.notes,
      },
    });

    const payload: DietAssignedEvent = {
      organizationId,
      dietAssignmentId: assignment.id,
      dietPlanId: plan.id,
      memberId: member.id,
      assignedByUserId,
    };
    this.events.emit(DomainEvent.DietAssigned, payload);
    return assignment;
  }
}
