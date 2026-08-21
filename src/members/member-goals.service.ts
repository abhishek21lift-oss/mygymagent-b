import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateMemberGoalMilestoneDto,
  UpdateMemberGoalMilestoneDto,
} from './dto/member-goal-milestone.dto';
import type {
  CreateMemberGoalDto,
  UpdateMemberGoalDto,
} from './dto/member-goal.dto';
import { MembersService } from './members.service';

@Injectable()
export class MemberGoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
  ) {}

  private async assertMemberVisible(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<void> {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  async listGoals(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.memberGoal.findMany({
      where: { organizationId, memberId },
      orderBy: { createdAt: 'desc' },
      include: { milestones: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async createGoal(
    organizationId: string,
    memberId: string,
    createdByUserId: string,
    dto: CreateMemberGoalDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.memberGoal.create({
      data: {
        ...dto,
        organizationId,
        memberId,
        createdByUserId,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
      },
    });
  }

  async updateGoal(
    organizationId: string,
    memberId: string,
    goalId: string,
    dto: UpdateMemberGoalDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findGoalOrThrow(organizationId, memberId, goalId);
    return this.prisma.memberGoal.update({
      where: { id: goalId },
      data: {
        ...dto,
        targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
        achievedAt: dto.status === 'ACHIEVED' ? new Date() : undefined,
      },
    });
  }

  async createMilestone(
    organizationId: string,
    memberId: string,
    goalId: string,
    dto: CreateMemberGoalMilestoneDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findGoalOrThrow(organizationId, memberId, goalId);
    return this.prisma.memberGoalMilestone.create({
      data: {
        ...dto,
        organizationId,
        goalId,
        targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
      },
    });
  }

  async updateMilestone(
    organizationId: string,
    memberId: string,
    goalId: string,
    milestoneId: string,
    dto: UpdateMemberGoalMilestoneDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findGoalOrThrow(organizationId, memberId, goalId);
    const milestone = await this.prisma.memberGoalMilestone.findFirst({
      where: { id: milestoneId, organizationId, goalId },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    return this.prisma.memberGoalMilestone.update({
      where: { id: milestoneId },
      data: {
        ...dto,
        targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
        achievedAt: dto.achievedAt ? new Date(dto.achievedAt) : undefined,
      },
    });
  }

  private async findGoalOrThrow(
    organizationId: string,
    memberId: string,
    goalId: string,
  ) {
    const goal = await this.prisma.memberGoal.findFirst({
      where: { id: goalId, organizationId, memberId },
    });
    if (!goal) throw new NotFoundException('Goal not found');
    return goal;
  }
}
