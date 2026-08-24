import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateWorkoutAssignmentStatusDto } from './dto/update-workout-assignment-status.dto';
import type { WorkoutAssignmentStatus } from '@prisma/client';

@Injectable()
export class WorkoutAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    status?: WorkoutAssignmentStatus,
  ) {
    const where = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(status ? { status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.workoutAssignment.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          workoutPlan: { select: { id: true, name: true } },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.workoutAssignment.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async updateStatus(
    organizationId: string,
    id: string,
    dto: UpdateWorkoutAssignmentStatusDto,
  ) {
    const assignment = await this.prisma.workoutAssignment.findFirst({
      where: { id, organizationId },
    });
    if (!assignment)
      throw new NotFoundException('Workout assignment not found');

    return this.prisma.workoutAssignment.update({
      where: { id },
      data: { status: dto.status },
    });
  }
}