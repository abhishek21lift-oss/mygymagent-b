import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';
import type {
  CreateMemberTagDto,
  UpdateMemberTagDto,
  AssignMemberTagsDto,
} from './dto/member-tag.dto';

@Injectable()
export class MemberTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
  ) {}

  // --- Tag CRUD (org-scoped) ---

  async listTags(organizationId: string) {
    return this.prisma.memberTag.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { memberAssignments: true } },
      },
    });
  }

  async getTag(organizationId: string, tagId: string) {
    const tag = await this.prisma.memberTag.findFirst({
      where: { id: tagId, organizationId },
      include: {
        _count: { select: { memberAssignments: true } },
      },
    });
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  async createTag(
    organizationId: string,
    dto: CreateMemberTagDto,
    _createdByUserId: string | null,
  ) {
    const existing = await this.prisma.memberTag.findFirst({
      where: { organizationId, name: dto.name },
    });
    if (existing) {
      throw new BadRequestException('Tag with this name already exists');
    }

    return this.prisma.memberTag.create({
      data: {
        organizationId,
        name: dto.name,
        color: dto.color ?? '#6366f1',
      },
    });
  }

  async updateTag(
    organizationId: string,
    tagId: string,
    dto: UpdateMemberTagDto,
  ) {
    const existing = await this.prisma.memberTag.findFirst({
      where: { id: tagId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException('Tag not found');
    }

    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.prisma.memberTag.findFirst({
        where: { organizationId, name: dto.name, id: { not: tagId } },
      });
      if (duplicate) {
        throw new BadRequestException('Tag with this name already exists');
      }
    }

    return this.prisma.memberTag.update({
      where: { id: tagId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
    });
  }

  async deleteTag(organizationId: string, tagId: string) {
    const existing = await this.prisma.memberTag.findFirst({
      where: { id: tagId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException('Tag not found');
    }

    await this.prisma.memberTag.delete({ where: { id: tagId } });
  }

  // --- Tag assignments (member-scoped) ---

  async getMemberTags(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    return this.prisma.memberTagAssignment.findMany({
      where: { organizationId, memberId },
      include: { tag: true },
    });
  }

  async assignTags(
    organizationId: string,
    memberId: string,
    dto: AssignMemberTagsDto,
    assignedByUserId: string | null,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    // Verify all tags exist and belong to this org
    const tags = await this.prisma.memberTag.findMany({
      where: { id: { in: dto.tagIds }, organizationId },
    });
    if (tags.length !== dto.tagIds.length) {
      throw new BadRequestException('One or more tags not found');
    }

    // Remove existing assignments and create new ones
    await this.prisma.memberTagAssignment.deleteMany({
      where: { organizationId, memberId },
    });

    if (dto.tagIds.length === 0) {
      return [];
    }

    return this.prisma.memberTagAssignment.createMany({
      data: dto.tagIds.map((tagId) => ({
        organizationId,
        memberId,
        tagId,
        assignedByUserId,
      })),
    });
  }

  async addTagToMember(
    organizationId: string,
    memberId: string,
    tagId: string,
    assignedByUserId: string | null,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const tag = await this.prisma.memberTag.findFirst({
      where: { id: tagId, organizationId },
    });
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }

    // Check if already assigned
    const existing = await this.prisma.memberTagAssignment.findFirst({
      where: { organizationId, memberId, tagId },
    });
    if (existing) {
      throw new BadRequestException('Tag already assigned to this member');
    }

    return this.prisma.memberTagAssignment.create({
      data: {
        organizationId,
        memberId,
        tagId,
        assignedByUserId,
      },
      include: { tag: true },
    });
  }

  async removeTagFromMember(
    organizationId: string,
    memberId: string,
    tagId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const existing = await this.prisma.memberTagAssignment.findFirst({
      where: { organizationId, memberId, tagId },
    });
    if (!existing) {
      throw new NotFoundException('Tag assignment not found');
    }

    await this.prisma.memberTagAssignment.delete({
      where: { id: existing.id },
    });
  }
}
