import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, MemberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

/**
 * Production hardening seam for bulk Member OS mutations.
 * The MembersService token is bound to this implementation by MembersModule.
 */
@Injectable()
export class MemberIntegrityService extends MembersService {
  constructor(prisma: PrismaService, events: EventEmitter2) {
    super(prisma, events);
  }

  private get db(): PrismaService {
    return (this as unknown as { prisma: PrismaService }).prisma;
  }

  async bulkStatusChange(
    organizationId: string,
    memberIds: string[],
    status: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const nextStatus = status as MemberStatus;
    const scopedWhere: Prisma.MemberWhereInput = {
      id: { in: [...new Set(memberIds)] },
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
    };

    return this.db.$transaction(
      async (tx) => {
        const current = await tx.member.findMany({
          where: scopedWhere,
          select: { id: true, status: true },
        });
        const changed = current.filter(
          (member) => member.status !== nextStatus,
        );
        if (changed.length === 0) return { updated: 0 };

        await tx.member.updateMany({
          where: {
            id: { in: changed.map((member) => member.id) },
            organizationId,
            deletedAt: null,
            status: { not: nextStatus },
          },
          data: { status: nextStatus, updatedAt: new Date() },
        });

        await tx.memberStatusHistory.createMany({
          data: changed.map((member) => ({
            organizationId,
            memberId: member.id,
            fromStatus: member.status,
            toStatus: nextStatus,
            changedByUserId: null,
          })),
        });

        return { updated: changed.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async bulkTagAssignment(
    organizationId: string,
    memberIds: string[],
    tagIds: string[],
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const uniqueTagIds = [...new Set(tagIds)];
    const uniqueMemberIds = [...new Set(memberIds)];
    const scopedWhere: Prisma.MemberWhereInput = {
      id: { in: uniqueMemberIds },
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
    };

    return this.db.$transaction(
      async (tx) => {
        const [members, tags] = await Promise.all([
          tx.member.findMany({ where: scopedWhere, select: { id: true } }),
          tx.memberTag.findMany({
            where: { id: { in: uniqueTagIds }, organizationId },
            select: { id: true },
          }),
        ]);

        if (tags.length !== uniqueTagIds.length) {
          throw new BadRequestException('One or more tags not found');
        }

        const authorizedIds = members.map((member) => member.id);
        if (authorizedIds.length === 0) return { assigned: 0 };

        await tx.memberTagAssignment.deleteMany({
          where: { organizationId, memberId: { in: authorizedIds } },
        });

        if (uniqueTagIds.length === 0)
          return { assigned: authorizedIds.length };

        await tx.memberTagAssignment.createMany({
          data: authorizedIds.flatMap((memberId) =>
            uniqueTagIds.map((tagId) => ({
              organizationId,
              memberId,
              tagId,
              assignedAt: new Date(),
            })),
          ),
          skipDuplicates: true,
        });

        return { assigned: authorizedIds.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
