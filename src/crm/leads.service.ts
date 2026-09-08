import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { CommunicationsService } from '../communications/communications.service';
import { DomainEvent, type LeadConvertedEvent } from '../events/domain-events';
import { MembersService } from '../members/members.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { CreateFollowUpDto } from './dto/create-follow-up.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { SendLeadMessageDto } from './dto/send-lead-message.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { LeadScoringService, type LeadScore } from './lead-scoring.service';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membersService: MembersService,
    private readonly events: EventEmitter2,
    private readonly scoring: LeadScoringService,
    private readonly communications: CommunicationsService,
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
      dto.branchId ?? branchScope ?? undefined,
      dto.assignedToUserId,
    );
    const { trialScheduledFor, ...rest } = dto;
    return this.prisma.lead.create({
      data: {
        organizationId,
        ...rest,
        ...(trialScheduledFor
          ? { trialScheduledFor: new Date(trialScheduledFor) }
          : {}),
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
    const { trialScheduledFor, ...rest } = dto;
    return this.prisma.lead.update({
      where: { id },
      data: {
        ...rest,
        ...(trialScheduledFor !== undefined
          ? {
              trialScheduledFor:
                trialScheduledFor === null ? null : new Date(trialScheduledFor),
            }
          : {}),
      },
    });
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
    if (dto.status === 'LOST' && !dto.reason?.trim()) {
      throw new BadRequestException(
        'A reason is required when marking a lead lost',
      );
    }
    const data: Prisma.LeadUpdateInput = { status: dto.status };
    if (dto.status === 'LOST') {
      data.lostReason = dto.reason!.trim();
    } else {
      // Leaving the lost state: clear the stale reason so reports stay clean.
      data.lostReason = null;
    }
    return this.prisma.lead.update({ where: { id }, data });
  }

  /** Deterministic, explainable score for one lead (leads.read). */
  async getScore(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ): Promise<LeadScore> {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: { followUps: { select: { completedAt: true } } },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return this.scoring.score(lead as never);
  }

  /**
   * Sends an outreach EMAIL or WHATSAPP message to a lead. Leads are not
   * members, so the member-consent gate does not apply; every send is
   * persisted to MessageLog for auditability.
   */
  async sendMessage(
    organizationId: string,
    id: string,
    dto: SendLeadMessageDto,
    branchScope: string | null = null,
  ) {
    const lead = await this.getOne(organizationId, id, branchScope);
    if (dto.channel === 'EMAIL' && !lead.email) {
      throw new BadRequestException('This lead has no email on file');
    }
    if (dto.channel === 'WHATSAPP' && !lead.phone) {
      throw new BadRequestException('This lead has no phone on file');
    }
    if (!dto.customBody?.trim()) {
      throw new BadRequestException('A message body is required');
    }
    return this.communications.send({
      organizationId,
      channel: dto.channel,
      // Manual one-off outreach to a prospect -- transactional messaging.
      category: 'TRANSACTIONAL',
      templateKey: 'lead_outreach',
      recipient: dto.channel === 'EMAIL' ? lead.email! : lead.phone!,
      customSubject: dto.subject ?? `A message from your gym`,
      customBody: dto.customBody,
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

    await this.validateReferences(
      organizationId,
      branchId,
      dto.assignedTrainerId,
    );

    const member = await this.membersService.create(
      organizationId,
      {
        primaryBranchId: branchId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email ?? undefined,
        phone: lead.phone ?? undefined,
        assignedTrainerId: dto.assignedTrainerId ?? undefined,
        leadSource: lead.source ?? undefined,
        notes: lead.notes ?? undefined,
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
    assignedToUserId?: string | null,
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
