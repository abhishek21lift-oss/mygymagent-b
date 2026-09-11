import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  BulkExportDto,
  BulkStatusChangeDto,
  BulkTagAssignmentDto,
} from './dto/member-bulk.dto';

function escapeCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Bulk member operations from the directory's selection bar. Status
 * changes reuse the same status-history write MembersService.update()
 * performs per-row, so bulk edits never create history gaps. Export
 * returns CSV text (the only format the directory UI parses today --
 * `format: xlsx` is accepted but served as CSV; requesting anything
 * else is a 400, never a silent wrong-format file).
 */
@Injectable()
export class MemberBulkService {
  constructor(private readonly prisma: PrismaService) {}

  async changeStatus(
    organizationId: string,
    dto: BulkStatusChangeDto,
    changedByUserId: string,
    branchScope: string | null = null,
  ) {
    if (dto.memberIds.length === 0)
      throw new BadRequestException('memberIds must not be empty');
    if (dto.memberIds.length > 500)
      throw new BadRequestException(
        'Bulk status change is limited to 500 members at a time',
      );

    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        id: { in: dto.memberIds },
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: { id: true, status: true },
    });
    if (members.length !== dto.memberIds.length)
      throw new NotFoundException(
        'One or more members were not found in your scope',
      );

    const changed = members.filter((m) => m.status !== dto.status);
    await this.prisma.$transaction(async (tx) => {
      await tx.member.updateMany({
        where: { id: { in: changed.map((m) => m.id) } },
        data: { status: dto.status },
      });
      if (changed.length > 0) {
        await tx.memberStatusHistory.createMany({
          data: changed.map((m) => ({
            organizationId,
            memberId: m.id,
            fromStatus: m.status,
            toStatus: dto.status,
            changedByUserId,
          })),
        });
      }
    });
    return { updated: changed.length };
  }

  async assignTags(
    organizationId: string,
    dto: BulkTagAssignmentDto,
    assignedByUserId: string,
    branchScope: string | null = null,
  ) {
    if (dto.memberIds.length === 0 || dto.tagIds.length === 0)
      throw new BadRequestException('memberIds and tagIds must not be empty');
    if (dto.memberIds.length > 500)
      throw new BadRequestException(
        'Bulk tag assignment is limited to 500 members at a time',
      );

    const [members, tags] = await Promise.all([
      this.prisma.member.findMany({
        where: {
          organizationId,
          id: { in: dto.memberIds },
          deletedAt: null,
          ...(branchScope ? { primaryBranchId: branchScope } : {}),
        },
        select: { id: true },
      }),
      this.prisma.memberTag.findMany({
        where: { organizationId, id: { in: dto.tagIds } },
        select: { id: true },
      }),
    ]);
    if (members.length !== dto.memberIds.length)
      throw new NotFoundException(
        'One or more members were not found in your scope',
      );
    if (tags.length !== dto.tagIds.length)
      throw new NotFoundException('One or more tags were not found');

    let assigned = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const memberId of dto.memberIds) {
        for (const tagId of dto.tagIds) {
          const row = await tx.memberTagAssignment.upsert({
            where: { memberId_tagId: { memberId, tagId } },
            create: { organizationId, memberId, tagId, assignedByUserId },
            update: {},
          });
          if (row) assigned += 1;
        }
      }
    });
    return { assigned };
  }

  async export(
    organizationId: string,
    dto: BulkExportDto,
    branchScope: string | null = null,
  ): Promise<string> {
    if (dto.format && dto.format !== 'csv')
      throw new BadRequestException(
        'Only CSV export is supported; xlsx is not available',
      );
    if (dto.memberIds.length === 0)
      throw new BadRequestException('memberIds must not be empty');
    if (dto.memberIds.length > 2000)
      throw new BadRequestException(
        'Export is limited to 2000 members at a time',
      );

    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        id: { in: dto.memberIds },
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      include: {
        primaryBranch: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const headers = [
      'memberCode',
      'firstName',
      'lastName',
      'email',
      'phone',
      'status',
      'branch',
      'joinedAt',
    ];
    const lines = [
      headers.join(','),
      ...members.map((m) =>
        [
          m.memberCode,
          m.firstName,
          m.lastName,
          m.email ?? '',
          m.phone ?? '',
          m.status,
          m.primaryBranch.name,
          m.joinedAt.toISOString(),
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ];
    return lines.join('\n');
  }
}
