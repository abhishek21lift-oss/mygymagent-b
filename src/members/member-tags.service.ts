import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AssignMemberTagsDto,
  CreateMemberTagDto,
  UpdateMemberTagDto,
} from './dto/member-tag.dto';

/**
 * Org-level member tags ("VIP", "Needs attention") and their per-member
 * assignments. Tags are an org-owned vocabulary; assignments are the
 * per-member facts. Deleting a tag removes its assignments via cascade
 * (the assignment has no meaning without the tag).
 */
@Injectable()
export class MemberTagsService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.memberTag.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
  }

  async getOne(organizationId: string, tagId: string) {
    const tag = await this.prisma.memberTag.findFirst({
      where: { id: tagId, organizationId },
      include: { _count: { select: { assignments: true } } },
    });
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async create(organizationId: string, dto: CreateMemberTagDto) {
    const existing = await this.prisma.memberTag.findUnique({
      where: { organizationId_name: { organizationId, name: dto.name.trim() } },
    });
    if (existing)
      throw new ConflictException('A tag with this name already exists');
    return this.prisma.memberTag.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        ...(dto.color ? { color: dto.color } : {}),
      },
    });
  }

  async update(organizationId: string, tagId: string, dto: UpdateMemberTagDto) {
    await this.getOne(organizationId, tagId);
    if (dto.name) {
      const clash = await this.prisma.memberTag.findUnique({
        where: {
          organizationId_name: { organizationId, name: dto.name.trim() },
        },
      });
      if (clash && clash.id !== tagId)
        throw new ConflictException('A tag with this name already exists');
    }
    return this.prisma.memberTag.update({
      where: { id: tagId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.color ? { color: dto.color } : {}),
      },
    });
  }

  async remove(organizationId: string, tagId: string) {
    await this.getOne(organizationId, tagId);
    await this.prisma.memberTag.delete({ where: { id: tagId } });
    return { deleted: true };
  }

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

  async listAssignments(
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
    return this.prisma.memberTagAssignment.findMany({
      where: { organizationId, memberId },
      include: { tag: true },
      orderBy: { assignedAt: 'asc' },
    });
  }

  /**
   * Replace the member's tag set with exactly `tagIds` (idempotent --
   * re-sending the current set is a no-op). All tags must belong to
   * this organization.
   */
  async assign(
    organizationId: string,
    memberId: string,
    dto: AssignMemberTagsDto,
    assignedByUserId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    const tags = await this.prisma.memberTag.findMany({
      where: { organizationId, id: { in: dto.tagIds } },
    });
    if (tags.length !== dto.tagIds.length)
      throw new NotFoundException('One or more tags were not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.memberTagAssignment.deleteMany({
        where: {
          organizationId,
          memberId,
          tagId: { notIn: dto.tagIds },
        },
      });
      await Promise.all(
        dto.tagIds.map((tagId) =>
          tx.memberTagAssignment.upsert({
            where: { memberId_tagId: { memberId, tagId } },
            create: {
              organizationId,
              memberId,
              tagId,
              assignedByUserId,
            },
            update: {},
          }),
        ),
      );
    });
    return this.listAssignments(organizationId, memberId);
  }

  async addOne(
    organizationId: string,
    memberId: string,
    tagId: string,
    assignedByUserId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    const tag = await this.prisma.memberTag.findFirst({
      where: { id: tagId, organizationId },
    });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.prisma.memberTagAssignment.upsert({
      where: { memberId_tagId: { memberId, tagId } },
      create: { organizationId, memberId, tagId, assignedByUserId },
      update: {},
    });
    return this.listAssignments(organizationId, memberId);
  }

  async removeOne(
    organizationId: string,
    memberId: string,
    tagId: string,
    branchScope: string | null = null,
  ) {
    await this.requireMember(organizationId, memberId, branchScope);
    await this.prisma.memberTagAssignment.deleteMany({
      where: { organizationId, memberId, tagId },
    });
    return this.listAssignments(organizationId, memberId);
  }
}
