import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateMemberFollowUpDto,
  UpdateMemberFollowUpDto,
} from './dto/member-follow-up.dto';

const USER_SELECT = {
  select: { id: true, firstName: true, lastName: true },
};

/**
 * Member-level follow-up tasks. Reachable only nested under the member
 * (no standalone global list) -- same scoping rule LeadFollowUp uses
 * for leads. `isOverdue` is computed at read time (past dueAt and not
 * completed), never stored, so it can never drift stale.
 */
@Injectable()
export class MemberFollowUpsService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireMember(
    organizationId: string,
    memberId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  private withOverdue<
    T extends { dueAt: Date | null; completedAt: Date | null },
  >(followUp: T) {
    return {
      ...followUp,
      isOverdue:
        followUp.completedAt === null &&
        followUp.dueAt !== null &&
        followUp.dueAt.getTime() < Date.now(),
    };
  }

  async list(
    organizationId: string,
    memberId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    await this.requireMember(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const rows = await this.prisma.memberFollowUp.findMany({
      where: { organizationId, memberId },
      orderBy: [{ completedAt: 'asc' }, { dueAt: 'asc' }],
      include: { createdByUser: USER_SELECT, assignedToUser: USER_SELECT },
    });
    return rows.map((row) => this.withOverdue(row));
  }

  async create(
    organizationId: string,
    memberId: string,
    dto: CreateMemberFollowUpDto,
    createdByUserId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    if (dto.assignedToUserId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: dto.assignedToUserId, organizationId },
      });
      if (!assignee) throw new NotFoundException('Assignee not found');
    }
    const created = await this.prisma.memberFollowUp.create({
      data: {
        organizationId,
        memberId,
        title: dto.title.trim(),
        description: dto.description,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        priority: dto.priority ?? 'MEDIUM',
        createdByUserId,
        assignedToUserId: dto.assignedToUserId,
      },
      include: { createdByUser: USER_SELECT, assignedToUser: USER_SELECT },
    });
    return this.withOverdue(created);
  }

  async update(
    organizationId: string,
    memberId: string,
    followUpId: string,
    dto: UpdateMemberFollowUpDto,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });
    if (!existing) throw new NotFoundException('Follow-up not found');
    if (dto.assignedToUserId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: dto.assignedToUserId, organizationId },
      });
      if (!assignee) throw new NotFoundException('Assignee not found');
    }
    const updated = await this.prisma.memberFollowUp.update({
      where: { id: followUpId },
      data: {
        ...(dto.title ? { title: dto.title.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.dueAt !== undefined
          ? { dueAt: dto.dueAt ? new Date(dto.dueAt) : null }
          : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.assignedToUserId !== undefined
          ? { assignedToUserId: dto.assignedToUserId }
          : {}),
      },
      include: { createdByUser: USER_SELECT, assignedToUser: USER_SELECT },
    });
    return this.withOverdue(updated);
  }

  async complete(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });
    if (!existing) throw new NotFoundException('Follow-up not found');
    const updated = await this.prisma.memberFollowUp.update({
      where: { id: followUpId },
      data: { completedAt: new Date() },
      include: { createdByUser: USER_SELECT, assignedToUser: USER_SELECT },
    });
    return this.withOverdue(updated);
  }

  async uncomplete(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });
    if (!existing) throw new NotFoundException('Follow-up not found');
    const updated = await this.prisma.memberFollowUp.update({
      where: { id: followUpId },
      data: { completedAt: null },
      include: { createdByUser: USER_SELECT, assignedToUser: USER_SELECT },
    });
    return this.withOverdue(updated);
  }

  async remove(
    organizationId: string,
    memberId: string,
    followUpId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    const existing = await this.prisma.memberFollowUp.findFirst({
      where: { id: followUpId, organizationId, memberId },
    });
    if (!existing) throw new NotFoundException('Follow-up not found');
    await this.prisma.memberFollowUp.delete({ where: { id: followUpId } });
    return { deleted: true };
  }
}
