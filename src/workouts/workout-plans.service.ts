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
import {
  DomainEvent,
  type WorkoutAssignedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { AssignWorkoutPlanDto } from './dto/assign-workout-plan.dto';
import type { CreateWorkoutPlanDto } from './dto/create-workout-plan.dto';
import type { UpdateWorkoutPlanDto } from './dto/update-workout-plan.dto';

@Injectable()
export class WorkoutPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(organizationId: string, query: PaginationQueryDto) {
    const where = { organizationId };
    const [items, total] = await Promise.all([
      this.prisma.workoutPlan.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
      }),
      this.prisma.workoutPlan.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    const plan = await this.prisma.workoutPlan.findFirst({
      where: { id, organizationId },
    });
    if (!plan) throw new NotFoundException('Workout plan not found');
    return plan;
  }

  /** Every referenced exerciseId must belong to this organization -- a
   * plan can't be built pointing at another tenant's exercise library
   * entries just because the id was guessable. */
  private async assertExercisesBelongToOrg(
    organizationId: string,
    exerciseIds: string[],
  ): Promise<void> {
    if (exerciseIds.length === 0) return;
    const found = await this.prisma.exercise.findMany({
      where: { organizationId, id: { in: exerciseIds } },
      select: { id: true },
    });
    if (found.length !== new Set(exerciseIds).size) {
      throw new BadRequestException(
        'One or more exercises were not found in this organization',
      );
    }
  }

  async create(
    organizationId: string,
    dto: CreateWorkoutPlanDto,
    createdByUserId: string,
  ) {
    await this.assertExercisesBelongToOrg(
      organizationId,
      dto.exercises.map((e) => e.exerciseId),
    );
    return this.prisma.workoutPlan.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        exercises: dto.exercises as unknown as Prisma.InputJsonValue,
        createdByUserId,
      },
    });
  }

  async update(organizationId: string, id: string, dto: UpdateWorkoutPlanDto) {
    await this.getOne(organizationId, id);
    if (dto.exercises) {
      await this.assertExercisesBelongToOrg(
        organizationId,
        dto.exercises.map((e) => e.exerciseId),
      );
    }
    return this.prisma.workoutPlan.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.exercises !== undefined
          ? { exercises: dto.exercises as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async assign(
    organizationId: string,
    workoutPlanId: string,
    dto: AssignWorkoutPlanDto,
    assignedByUserId: string,
  ) {
    const [plan, member, assignedBy] = await Promise.all([
      this.getOne(organizationId, workoutPlanId),
      this.prisma.member.findFirst({
        where: { id: dto.memberId, organizationId, deletedAt: null },
      }),
      this.prisma.user.findFirst({
        where: {
          id: assignedByUserId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true, primaryBranchId: true },
      }),
    ]);
    if (!member) throw new NotFoundException('Member not found');
    if (!assignedBy) {
      throw new NotFoundException('Assigning user not found or inactive');
    }

    // Branch-scoped staff/trainers may only assign workouts to members
    // belonging to their own primary branch. Organization/platform-level
    // users have no primaryBranchId and remain organization-wide.
    if (assignedBy.primaryBranchId && member.primaryBranchId !== assignedBy.primaryBranchId) {
      throw new BadRequestException(
        'Cannot assign a workout to a member outside your assigned branch',
      );
    }

    const assignment = await this.prisma.workoutAssignment.create({
      data: {
        organizationId,
        workoutPlanId: plan.id,
        memberId: member.id,
        assignedByUserId: assignedBy.id,
        startDate: dto.startDate ? new Date(dto.startDate) : new Date(),
        notes: dto.notes,
      },
    });

    const payload: WorkoutAssignedEvent = {
      organizationId,
      workoutAssignmentId: assignment.id,
      workoutPlanId: plan.id,
      memberId: member.id,
      assignedByUserId: assignedBy.id,
    };
    this.events.emit(DomainEvent.WorkoutAssigned, payload);
    return assignment;
  }
}
