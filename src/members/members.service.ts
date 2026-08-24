import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { DomainEvent, type MemberCreatedEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMemberDto } from './dto/create-member.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    branchId?: string,
    assignmentScope: string | null = null,
  ) {
    const where: Prisma.MemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(branchId ? { primaryBranchId: branchId } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
              { memberCode: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: { primaryBranch: { select: { id: true, name: true } } },
      }),
      this.prisma.member.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.prisma.member.findFirst({
      where: {
        id,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      include: {
        primaryBranch: { select: { id: true, name: true } },
        assignedTrainer: {
          select: { id: true, firstName: true, lastName: true },
        },
        memberships: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { membershipPlan: true },
        },
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async create(
    organizationId: string,
    dto: CreateMemberDto,
    branchScope: string | null = null,
    createdByUserId: string | null = null,
  ) {
    if (branchScope && dto.primaryBranchId !== branchScope) {
      throw new BadRequestException(
        'Cannot create a member outside your assigned branch',
      );
    }
    await this.validateReferences(
      organizationId,
      dto.primaryBranchId,
      dto.assignedTrainerId,
    );
    const memberCode = await this.generateMemberCode(organizationId);
    const member = await this.prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          ...dto,
          organizationId,
          memberCode,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        },
      });
      await tx.memberStatusHistory.create({
        data: {
          organizationId,
          memberId: created.id,
          fromStatus: null,
          toStatus: created.status,
          changedByUserId: createdByUserId,
        },
      });
      await tx.memberBranchHistory.create({
        data: {
          organizationId,
          memberId: created.id,
          fromBranchId: null,
          toBranchId: created.primaryBranchId,
          changedByUserId: createdByUserId,
        },
      });
      if (created.assignedTrainerId) {
        await tx.memberTrainerHistory.create({
          data: {
            organizationId,
            memberId: created.id,
            fromTrainerId: null,
            toTrainerId: created.assignedTrainerId,
            changedByUserId: createdByUserId,
          },
        });
      }
      return created;
    });
    const payload: MemberCreatedEvent = {
      organizationId,
      branchId: member.primaryBranchId,
      memberId: member.id,
      email: member.email ?? undefined,
      firstName: member.firstName,
    };
    this.events.emit(DomainEvent.MemberCreated, payload);
    return member;
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateMemberDto,
    branchScope: string | null = null,
    changedByUserId: string | null = null,
  ) {
    const before = await this.getOne(organizationId, id, branchScope);
    if (
      branchScope &&
      dto.primaryBranchId !== undefined &&
      dto.primaryBranchId !== branchScope
    ) {
      throw new BadRequestException(
        'Cannot move a member outside your assigned branch',
      );
    }
    await this.validateReferences(
      organizationId,
      dto.primaryBranchId,
      dto.assignedTrainerId,
    );
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.member.update({
        where: { id },
        data: {
          ...dto,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        },
      });
      if (dto.status !== undefined && dto.status !== before.status) {
        await tx.memberStatusHistory.create({
          data: {
            organizationId,
            memberId: id,
            fromStatus: before.status,
            toStatus: updated.status,
            changedByUserId,
          },
        });
      }
      if (
        dto.primaryBranchId !== undefined &&
        dto.primaryBranchId !== before.primaryBranchId
      ) {
        await tx.memberBranchHistory.create({
          data: {
            organizationId,
            memberId: id,
            fromBranchId: before.primaryBranchId,
            toBranchId: updated.primaryBranchId,
            changedByUserId,
          },
        });
      }
      if (
        dto.assignedTrainerId !== undefined &&
        dto.assignedTrainerId !== before.assignedTrainerId
      ) {
        await tx.memberTrainerHistory.create({
          data: {
            organizationId,
            memberId: id,
            fromTrainerId: before.assignedTrainerId,
            toTrainerId: updated.assignedTrainerId,
            changedByUserId,
          },
        });
      }
      return updated;
    });
  }

  async getStatusHistory(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope, assignmentScope);
    return this.prisma.memberStatusHistory.findMany({
      where: { organizationId, memberId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        changedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async getBranchHistory(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope, assignmentScope);
    return this.prisma.memberBranchHistory.findMany({
      where: { organizationId, memberId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        fromBranch: { select: { id: true, name: true } },
        toBranch: { select: { id: true, name: true } },
        changedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async getTrainerHistory(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope, assignmentScope);
    return this.prisma.memberTrainerHistory.findMany({
      where: { organizationId, memberId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        fromTrainer: { select: { id: true, firstName: true, lastName: true } },
        toTrainer: { select: { id: true, firstName: true, lastName: true } },
        changedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async remove(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    await this.getOne(organizationId, id, branchScope);
    return this.prisma.member.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });
  }

  private async validateReferences(
    organizationId: string,
    primaryBranchId?: string,
    assignedTrainerId?: string | null,
  ) {
    if (primaryBranchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: primaryBranchId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw new BadRequestException('Branch does not belong to this organization');
    }
    if (assignedTrainerId) {
      const trainer = await this.prisma.user.findFirst({
        where: { id: assignedTrainerId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!trainer) throw new BadRequestException('Trainer does not belong to this organization');
    }
  }

  private async generateMemberCode(organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const count = await this.prisma.member.count({
        where: { organizationId },
      });
      const candidate = `M-${String(count + 1 + attempt).padStart(6, '0')}`;
      const collision = await this.prisma.member.findFirst({
        where: { organizationId, memberCode: candidate },
        select: { id: true },
      });
      if (!collision) return candidate;
    }
    return `M-${Date.now()}`;
  }
}
