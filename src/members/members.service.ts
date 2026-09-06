import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { DomainEvent, type MemberCreatedEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMemberDto } from './dto/create-member.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';
import type { ListMembersQueryDto } from './dto/list-members-query.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: ListMembersQueryDto,
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
      ...(query.status && query.status.length > 0
        ? { status: { in: query.status } }
        : {}),
      ...(query.memberType && query.memberType.length > 0
        ? { memberType: { in: query.memberType } }
        : {}),
      ...(query.trainerId && query.trainerId.length > 0
        ? { assignedTrainerId: { in: query.trainerId } }
        : {}),
      ...(query.branchId && query.branchId.length > 0
        ? { primaryBranchId: { in: query.branchId } }
        : {}),
      ...(query.tagIds && query.tagIds.length > 0
        ? {
            tagAssignments: {
              some: {
                tagId: { in: query.tagIds },
              },
            },
          }
        : {}),
      ...(query.joinedFrom
        ? { joinedAt: { gte: new Date(query.joinedFrom) } }
        : {}),
      ...(query.joinedTo
        ? { joinedAt: { lte: new Date(query.joinedTo) } }
        : {}),
    };

    const orderByField = query.orderBy ?? 'createdAt';
    const orderBy = { [orderByField]: query.order ?? 'desc' };

    const [items, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        ...skipTake(query),
        orderBy,
        include: {
          primaryBranch: { select: { id: true, name: true } },
          assignedTrainer: {
            select: { id: true, firstName: true, lastName: true },
          },
          tagAssignments: { include: { tag: true } },
        },
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
    emergencyContactRelationship?: string,
    waiverConsent?: boolean,
    fitnessGoal?: string,
    injuries?: string,
    allergies?: string,
    medicalNotes?: string,
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
      // Create emergency contact with relationship if provided
      if (dto.emergencyContactName || dto.emergencyContactPhone) {
        await tx.memberEmergencyContact.create({
          data: {
            organizationId,
            memberId: created.id,
            name: dto.emergencyContactName || '',
            phone: dto.emergencyContactPhone || '',
            relationship: emergencyContactRelationship || null,
            isPrimary: true,
          },
        });
      }
      // Create waiver consent if provided
      if (waiverConsent !== undefined) {
        await tx.memberConsent.create({
          data: {
            organizationId,
            memberId: created.id,
            type: 'WAIVER',
            granted: waiverConsent,
            note:
              injuries || allergies
                ? `Injuries: ${injuries || 'None'}. Allergies: ${allergies || 'None'}`
                : undefined,
            recordedByUserId: createdByUserId,
          },
        });
      }
      // Create fitness goal if provided
      if (fitnessGoal) {
        await tx.memberGoal.create({
          data: {
            organizationId,
            memberId: created.id,
            title: fitnessGoal,
            category: 'GENERAL_FITNESS',
            description: medicalNotes || undefined,
            startDate: new Date(),
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

  async getMembershipBilling(
    organizationId: string,
    memberId: string,
    branchScope: string | null = null,
  ) {
    const where: Prisma.MemberWhereInput = {
      id: memberId,
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
    };
    const member = await this.prisma.member.findFirst({ where });
    if (!member) throw new NotFoundException('Member not found');
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId, memberId },
      orderBy: { createdAt: 'desc' },
      include: { membershipPlan: true },
    });
    const membershipIds = new Set(memberships.map((m) => m.id));

    const payments = await this.prisma.payment.findMany({
      where: {
        organizationId,
        memberId,
        status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] },
      },
      select: { id: true, amount: true, membershipId: true },
    });

    const refunds = await this.prisma.refund.findMany({
      where: {
        organizationId,
        payment: {
          memberId,
          membershipId: { not: null },
        },
      },
      select: { amount: true, paymentId: true },
    });

    const paymentIdsForMemberships = new Set(
      payments
        .filter((p) => p.membershipId && membershipIds.has(p.membershipId))
        .map((p) => p.id),
    );

    const totalPaid = payments
      .filter((p) => p.membershipId && membershipIds.has(p.membershipId))
      .reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

    const totalRefunded = refunds
      .filter((r) => paymentIdsForMemberships.has(r.paymentId))
      .reduce((sum, r) => sum.plus(r.amount), new Prisma.Decimal(0));

    const totalDue = memberships.reduce(
      (sum, m) => sum.plus(m.price.sub(m.discount ?? new Prisma.Decimal(0))),
      new Prisma.Decimal(0),
    );
    const outstandingBalance = totalDue.sub(totalPaid).add(totalRefunded);
    return {
      memberships: memberships.map((m) => ({
        id: m.id,
        planName: m.membershipPlan.name,
        price: m.price,
        discount: m.discount,
        finalPrice: m.price.sub(m.discount ?? new Prisma.Decimal(0)),
        startDate: m.startDate,
        endDate: m.endDate,
        status: m.status,
      })),
      totalDue,
      totalPaid,
      totalRefunded,
      outstandingBalance,
    };
  }

  async bulkStatusChange(
    organizationId: string,
    memberIds: string[],
    status: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const scopedMemberFilter: Prisma.MemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
    };

    const members = await this.prisma.member.findMany({
      where: { id: { in: memberIds }, ...scopedMemberFilter },
      select: { id: true },
    });
    const authorizedIds = members.map((m) => m.id);

    if (authorizedIds.length === 0) {
      return { updated: 0 };
    }

    await this.prisma.member.updateMany({
      where: { id: { in: authorizedIds } },
      data: { status: status as any, updatedAt: new Date() },
    });

    return { updated: authorizedIds.length };
  }

  async bulkTagAssignment(
    organizationId: string,
    memberIds: string[],
    tagIds: string[],
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const scopedMemberFilter: Prisma.MemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
    };

    const members = await this.prisma.member.findMany({
      where: { id: { in: memberIds }, ...scopedMemberFilter },
      select: { id: true },
    });
    const authorizedIds = members.map((m) => m.id);

    if (authorizedIds.length === 0) {
      return { assigned: 0 };
    }

    await this.prisma.memberTagAssignment.deleteMany({
      where: { memberId: { in: authorizedIds } },
    });

    await this.prisma.memberTagAssignment.createMany({
      data: authorizedIds.flatMap((memberId) =>
        tagIds.map((tagId) => ({
          memberId,
          tagId,
          organizationId,
          assignedAt: new Date(),
        })),
      ),
      skipDuplicates: true,
    });

    return { assigned: authorizedIds.length };
  }

  async bulkExport(
    organizationId: string,
    memberIds: string[],
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const scopedMemberFilter: Prisma.MemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
    };

    const where =
      memberIds.length > 0
        ? { id: { in: memberIds }, ...scopedMemberFilter }
        : scopedMemberFilter;

    const members = await this.prisma.member.findMany({
      where,
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        memberType: true,
        joinedAt: true,
        createdAt: true,
        primaryBranch: { select: { name: true } },
        assignedTrainer: { select: { firstName: true, lastName: true } },
        tagAssignments: { include: { tag: { select: { name: true } } } },
      },
    });

    const rows = members.map((m) => ({
      memberCode: m.memberCode,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email ?? '',
      phone: m.phone ?? '',
      status: m.status,
      memberType: m.memberType,
      branch: m.primaryBranch?.name ?? '',
      trainer: m.assignedTrainer
        ? `${m.assignedTrainer.firstName} ${m.assignedTrainer.lastName}`
        : '',
      joinedAt: m.joinedAt
        ? new Date(m.joinedAt).toISOString().split('T')[0]
        : '',
      tags: m.tagAssignments.map((t) => t.tag.name).join('; '),
    }));

    return { members: rows, total: rows.length };
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
      if (!branch) {
        throw new BadRequestException(
          'Branch does not belong to this organization',
        );
      }
    }
    if (assignedTrainerId) {
      const trainer = await this.prisma.user.findFirst({
        where: { id: assignedTrainerId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!trainer) {
        throw new BadRequestException(
          'Trainer does not belong to this organization',
        );
      }
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
