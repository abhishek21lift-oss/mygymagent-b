import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { DomainEvent, type LeadConvertedEvent } from '../events/domain-events';
import { MembersService } from '../members/members.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ConvertLeadDto } from './dto/convert-lead.dto';
import type { CreateFollowUpDto } from './dto/create-follow-up.dto';
import type { CreateLeadDto } from './dto/create-lead.dto';
import type { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import type { UpdateLeadDto } from './dto/update-lead.dto';
import type { UpdateLeadStatusDto } from './dto/update-lead-status.dto';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membersService: MembersService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: ListLeadsQueryDto,
    branchScope: string | null = null,
  ) {
    const where: Prisma.LeadWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.assignedToUserId
        ? { assignedToUserId: query.assignedToUserId }
        : {}),
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          assignedToUser: {
            select: { id: true, firstName: true, lastName: true },
          },
          _count: { select: { followUps: true } },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: {
        assignedToUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        followUps: { orderBy: { dueAt: 'asc' } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async create(
    organizationId: string,
    dto: CreateLeadDto,
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot create a lead outside your assigned branch',
      );
    }
    await this.validateReferences(
      organizationId,
      dto.branchId ?? branchScope,
      dto.assignedToUserId,
    );
    return this.prisma.lead.create({
      data: {
        organizationId,
        ...dto,
        branchId: dto.branchId ?? branchScope ?? undefined,
      },
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateLeadDto,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (
      branchScope &&
      dto.branchId !== undefined &&
      dto.branchId !== branchScope
    ) {
      throw new BadRequestException(
        'Cannot move a lead outside your assigned branch',
      );
    }
    await this.validateReferences(
      organizationId,
      dto.branchId ?? existing.branchId ?? branchScope ?? undefined,
      dto.assignedToUserId,
    );
    return this.prisma.lead.update({ where: { id }, data: dto });
  }

  async updateStatus(
    organizationId: string,
    id: string,
    dto: UpdateLeadStatusDto,
    branchScope: string | null = null,
  ) {
    const lead = await this.getOne(organizationId, id, branchScope);
    if (lead.status === 'WON') {
      throw new BadRequestException(
        'A won lead has already been converted; its status cannot be changed directly',
      );
    }
    return this.prisma.lead.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  /** Creates a real Member from this lead's info and marks the lead WON. */
  async convert(
    organizationId: string,
    id: string,
    dto: ConvertLeadDto,
    branchScope: string | null = null,
  ) {
    const lead = await this.getOne(organizationId, id, branchScope);
    if (lead.status === 'WON') {
      throw new BadRequestException('This lead has already been converted');
    }
    const branchId = dto.branchId ?? lead.branchId;
    if (!branchId) {
      throw new BadRequestException(
        'branchId is required: this lead has no branch on file',
      );
    }

    const member = await this.membersService.create(
      organizationId,
      {
        primaryBranchId: branchId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email ?? undefined,
        phone: lead.phone ?? undefined,
      },
      branchScope,
    );

    const converted = await this.prisma.lead.update({
      where: { id },
      data: {
        status: 'WON',
        convertedMemberId: member.id,
        convertedAt: new Date(),
      },
    });

    const payload: LeadConvertedEvent = {
      organizationId,
      leadId: lead.id,
      memberId: member.id,
    };
    this.events.emit(DomainEvent.LeadConverted, payload);

    return { lead: converted, member };
  }

  async addFollowUp(
    organizationId: string,
    leadId: string,
    dto: CreateFollowUpDto,
    createdByUserId: string,
    branchScope: string | null = null,
  ) {
    await this.getOne(organizationId, leadId, branchScope);
    return this.prisma.leadFollowUp.create({
      data: {
        organizationId,
        leadId,
        dueAt: new Date(dto.dueAt),
        note: dto.note,
        createdByUserId,
      },
    });
  }

  async completeFollowUp(
    organizationId: string,
    leadId: string,
    followUpId: string,
    branchScope: string | null = null,
  ) {
    await this.getOne(organizationId, leadId, branchScope);
    const followUp = await this.prisma.leadFollowUp.findFirst({
      where: { id: followUpId, leadId, organizationId },
    });
    if (!followUp) throw new NotFoundException('Follow-up not found');
    return this.prisma.leadFollowUp.update({
      where: { id: followUpId },
      data: { completedAt: new Date() },
    });
  }

  private async validateReferences(
    organizationId: string,
    branchId?: string,
    assignedToUserId?: string,
  ) {
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: {
          id: branchId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!branch) {
        throw new BadRequestException(
          'Branch does not belong to this organization',
        );
      }
    }

    if (assignedToUserId) {
      const user = await this.prisma.user.findFirst({
        where: {
          id: assignedToUserId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!user) {
        throw new BadRequestException(
          'Assigned user does not belong to this organization',
        );
      }
    }
  }
}
