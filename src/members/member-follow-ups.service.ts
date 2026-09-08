import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';
import type {
  CreateMemberFollowUpDto,
  UpdateMemberFollowUpDto,
} from './dto/member-follow-up.dto';

@Injectable()
export class MemberFollowUpsService {
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

  async list(
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

    const now = new Date();
    const items = await this.prisma.memberFollowUp.findMany({
      where: { organizationId, memberId },
      orderBy: [
        { completedAt: 'asc' },
        { dueAt: 'asc' },
        { createdAt: 'desc' },
      ],
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    return items.map((item) => ({
      ...item,
      isOverdue:
        item.completedAt === null && item.dueAt !== null && item.dueAt < now,
    }));
  }

  async getOne(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const item = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    if (!item) {
      throw new NotFoundException('Follow-up not found');
    }

    const now = new Date();
    return {
      ...item,
      isOverdue:
        item.completedAt === null && item.dueAt !== null && item.dueAt < now,
    };
  }

  async create(
    organizationId: string,
    memberId: string,
    dto: CreateMemberFollowUpDto,
    createdByUserId: string | null,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    return this.prisma.memberFollowUp.create({
      data: {
        organizationId,
        memberId,
        title: dto.title,
        description: dto.description,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        priority: dto.priority,
        createdByUserId,
        assignedToUserId: dto.assignedToUserId,
      },
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async update(
    organizationId: string,
    memberId: string,
    followUpId: string,
    dto: UpdateMemberFollowUpDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });

    if (!existing) {
      throw new NotFoundException('Follow-up not found');
    }

    return this.prisma.memberFollowUp.update({
      where: { id: followUpId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.dueAt !== undefined && {
          dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.assignedToUserId !== undefined && {
          assignedToUserId: dto.assignedToUserId,
        }),
      },
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async complete(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });

    if (!existing) {
      throw new NotFoundException('Follow-up not found');
    }

    return this.prisma.memberFollowUp.update({
      where: { id: followUpId },
      data: { completedAt: new Date() },
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async uncomplete(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });

    if (!existing) {
      throw new NotFoundException('Follow-up not found');
    }

    return this.prisma.memberFollowUp.update({
      where: { id: followUpId },
      data: { completedAt: null },
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async delete(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });

    if (!existing) {
      throw new NotFoundException('Follow-up not found');
    }

    await this.prisma.memberFollowUp.delete({ where: { id: followUpId } });
  }
}
