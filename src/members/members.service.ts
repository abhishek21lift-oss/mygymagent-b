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
import type { ListMembersQueryDto } from './dto/list-members-query.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';

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
      ...(branchId
        ? { primaryBranchId: branchId }
        : query.branchId?.length
          ? { primaryBranchId: { in: query.branchId } }
          : {}),
      ...(assignmentScope
        ? { assignedTrainerId: assignmentScope }
        : query.trainerId?.length
          ? { assignedTrainerId: { in: query.trainerId } }
          : {}),
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.memberType?.length
        ? { memberType: { in: query.memberType } }
        : {}),
      ...(query.tagIds?.length
        ? { tagAssignments: { some: { tagId: { in: query.tagIds } } } }
        : {}),
      ...(query.joinedFrom || query.joinedTo
        ? {
            joinedAt: {
              ...(query.joinedFrom ? { gte: new Date(query.joinedFrom) } : {}),
              ...(query.joinedTo ? { lte: new Date(query.joinedTo) } : {}),
            },
          }
        : {}),
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
        orderBy: { [query.orderBy ?? 'createdAt']: query.order ?? 'desc' },
        include: { primaryBranch: { select: { id: true, name: true } } },
      }),
      this.prisma.member.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getMetrics(
    organizationId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const where: Prisma.MemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(branchScope ? { primaryBranchId: branchScope } : {}),
      ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
    };

    const [total, active, inactive, frozen, expired, pt] = await Promise.all([
      this.prisma.member.count({ where }),
      this.prisma.member.count({ where: { ...where, status: 'ACTIVE' } }),
      this.prisma.member.count({ where: { ...where, status: 'INACTIVE' } }),
      this.prisma.member.count({ where: { ...where, status: 'FROZEN' } }),
      this.prisma.member.count({ where: { ...where, status: 'EXPIRED' } }),
      this.prisma.member.count({
        where: { ...where, memberType: { in: ['PT', 'GYM_PT'] } },
      }),
    ]);

    return { total, active, inactive, frozen, expired, pt };
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
    const {
      emergencyContactRelationship,
      waiverConsent,
      fitnessGoal,
      injuries,
      allergies,
      medicalNotes,
      ...memberData
    } = dto;

    const member = await this.prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          ...memberData,
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
      if (created.emergencyContactName || created.emergencyContactPhone) {
        await tx.memberEmergencyContact.create({
          data: {
            organizationId,
            memberId: created.id,
            name: created.emergencyContactName || '',
            phone: created.emergencyContactPhone || '',
            relationship: emergencyContactRelationship || null,
            isPrimary: true,
          },
        });
      }
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
                : medicalNotes || undefined,
            recordedByUserId: createdByUserId,
          },
        });
      }
      if (fitnessGoal) {
        await tx.memberGoal.create({
          data: {
            organizationId,
            memberId: created.id,
            title: fitnessGoal,
            category: 'GENERAL_FITNESS',
            description: medicalNotes || undefined,
            startDate: new Date(),
            createdByUserId: createdByUserId,
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
    const {
      emergencyContactRelationship,
      waiverConsent,
      fitnessGoal,
      injuries,
      allergies,
      medicalNotes,
      ...memberData
    } = dto;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.member.update({
        where: { id },
        data: {
          ...memberData,
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
      if (
        emergencyContactRelationship !== undefined ||
        dto.emergencyContactName !== undefined ||
        dto.emergencyContactPhone !== undefined
      ) {
        const existingPrimary = await tx.memberEmergencyContact.findFirst({
          where: { organizationId, memberId: id, isPrimary: true },
        });
        if (existingPrimary) {
          await tx.memberEmergencyContact.update({
            where: { id: existingPrimary.id },
            data: {
              name:
                dto.emergencyContactName !== undefined
                  ? dto.emergencyContactName || ''
                  : existingPrimary.name,
              phone:
                dto.emergencyContactPhone !== undefined
                  ? dto.emergencyContactPhone || ''
                  : existingPrimary.phone,
              relationship:
                emergencyContactRelationship !== undefined
                  ? emergencyContactRelationship || null
                  : existingPrimary.relationship,
            },
          });
        } else if (dto.emergencyContactName || dto.emergencyContactPhone) {
          await tx.memberEmergencyContact.create({
            data: {
              organizationId,
              memberId: id,
              name: dto.emergencyContactName || '',
              phone: dto.emergencyContactPhone || '',
              relationship: emergencyContactRelationship || null,
              isPrimary: true,
            },
          });
        }
      }
      if (waiverConsent !== undefined) {
        await tx.memberConsent.create({
          data: {
            organizationId,
            memberId: id,
            type: 'WAIVER',
            granted: waiverConsent,
            note:
              injuries || allergies
                ? `Injuries: ${injuries || 'None'}. Allergies: ${allergies || 'None'}`
                : medicalNotes || undefined,
            recordedByUserId: changedByUserId,
          },
        });
      }
      if (fitnessGoal) {
        await tx.memberGoal.create({
          data: {
            organizationId,
            memberId: id,
            title: fitnessGoal,
            category: 'GENERAL_FITNESS',
            description: medicalNotes || undefined,
            startDate: new Date(),
            createdByUserId: changedByUserId,
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
        where: {
          id: assignedTrainerId,
          organizationId,
          deletedAt: null,
          status: 'ACTIVE',
          staffProfile: { is: { isTrainer: true } },
        },
        select: {
          id: true,
          staffProfile: { select: { branchId: true } },
        },
      });
      if (!trainer) {
        throw new BadRequestException(
          'Assigned user must be an active trainer in this organization',
        );
      }
      if (
        primaryBranchId &&
        trainer.staffProfile?.branchId &&
        trainer.staffProfile.branchId !== primaryBranchId
      ) {
        throw new BadRequestException(
          'Assigned trainer is not compatible with the member branch',
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
