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

  async list(organizationId: string, query: ListLeadsQueryDto) {
    const where: Prisma.LeadWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.assignedToUserId
        ? { assignedToUserId: query.assignedToUserId }
        : {}),
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

  async getOne(organizationId: string, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, organizationId },
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

  create(organizationId: string, dto: CreateLeadDto) {
    return this.prisma.lead.create({ data: { organizationId, ...dto } });
  }

  async update(organizationId: string, id: string, dto: UpdateLeadDto) {
    await this.getOne(organizationId, id);
    return this.prisma.lead.update({ where: { id }, data: dto });
  }

  async updateStatus(
    organizationId: string,
    id: string,
    dto: UpdateLeadStatusDto,
  ) {
    const lead = await this.getOne(organizationId, id);
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

  /** Creates a real Member from this lead's info and marks the lead WON.
   * Delegates to MembersService.create() -- the same path the REST /members
   * endpoint uses -- rather than duplicating member-creation logic here. */
  async convert(organizationId: string, id: string, dto: ConvertLeadDto) {
    const lead = await this.getOne(organizationId, id);
    if (lead.status === 'WON') {
      throw new BadRequestException('This lead has already been converted');
    }
    const branchId = dto.branchId ?? lead.branchId;
    if (!branchId) {
      throw new BadRequestException(
        'branchId is required: this lead has no branch on file',
      );
    }

    const member = await this.membersService.create(organizationId, {
      primaryBranchId: branchId,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email ?? undefined,
      phone: lead.phone ?? undefined,
    });

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
  ) {
    await this.getOne(organizationId, leadId);
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
  ) {
    const followUp = await this.prisma.leadFollowUp.findFirst({
      where: { id: followUpId, leadId, organizationId },
    });
    if (!followUp) throw new NotFoundException('Follow-up not found');
    return this.prisma.leadFollowUp.update({
      where: { id: followUpId },
      data: { completedAt: new Date() },
    });
  }
}
