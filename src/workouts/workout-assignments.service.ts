import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkoutAssignmentStatus } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateWorkoutAssignmentStatusDto } from './dto/update-workout-assignment-status.dto';

@Injectable()
export class WorkoutAssignmentsService {
  /** Allowed transitions: ACTIVE -> COMPLETED/CANCELLED; terminal
   * statuses are frozen. Stops e.g. re-activating a completed assignment
   * (its workout sessions would be orphaned from the state machine) or
   * "completing" one that was cancelled. */
  private static readonly ALLOWED_TRANSITIONS: Record<
    string,
    WorkoutAssignmentStatus[]
  > = {
    ACTIVE: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  };

  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    assignmentScope: string | null = null,
    branchScope: string | null = null,
  ) {
    const memberWhere = {
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
    };
    const where = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(Object.keys(memberWhere).length > 0 ? { member: memberWhere } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.workoutAssignment.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          workoutPlan: { select: { id: true, name: true } },
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              assignedTrainerId: true,
            },
          },
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
    assignmentScope: string | null = null,
    branchScope: string | null = null,
  ) {
    const assignment = await this.prisma.workoutAssignment.findFirst({
      where: {
        id,
        organizationId,
        ...(assignmentScope || branchScope
          ? {
              member: {
                ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
                ...(branchScope ? { primaryBranchId: branchScope } : {}),
              },
            }
          : {}),
      },
    });
    if (!assignment)
      throw new NotFoundException('Workout assignment not found');

    if (dto.status !== assignment.status) {
      const allowed =
        WorkoutAssignmentsService.ALLOWED_TRANSITIONS[assignment.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `Cannot transition a ${assignment.status} workout assignment to ${dto.status}`,
        );
      }
    }

    return this.prisma.workoutAssignment.update({
      where: { id },
      data: { status: dto.status },
    });
  }
}
