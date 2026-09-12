import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { CommunicationsService } from '../communications/communications.service';
import {
  DomainEvent,
  type LeadConvertedEvent,
  type LeadCreatedEvent,
} from '../events/domain-events';
import { MembersService } from '../members/members.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CaptureLeadDto } from './dto/capture-lead.dto';
import type { ConvertLeadDto } from './dto/convert-lead.dto';
import type { CreateFollowUpDto } from './dto/create-follow-up.dto';
import type { CreateLeadDto } from './dto/create-lead.dto';
import type { ImportLeadsDto } from './dto/import-leads.dto';
import type { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import type { SendLeadMessageDto } from './dto/send-lead-message.dto';
import type { UpdateLeadDto } from './dto/update-lead.dto';
import type { UpdateLeadStatusDto } from './dto/update-lead-status.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membersService: MembersService,
    private readonly communications: CommunicationsService,
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
      dto.branchId ?? branchScope ?? undefined,
      dto.assignedToUserId,
    );
    const lead = await this.prisma.lead.create({
      data: {
        organizationId,
        ...dto,
        branchId: dto.branchId ?? branchScope ?? undefined,
      },
    });
    await this.prisma.leadSourceEvent.create({
      data: {
        organizationId,
        leadId: lead.id,
        channel: 'MANUAL',
        payload: dto.source ? { source: dto.source } : undefined,
      },
    });
    const created: LeadCreatedEvent = {
      organizationId,
      leadId: lead.id,
      branchId: lead.branchId,
      channel: 'MANUAL',
    };
    this.events.emit(DomainEvent.LeadCreated, created);
    return lead;
  }

  /**
   * Public web-form capture (POST /leads/capture). The organization is
   * derived from the submitted branchId -- a public form has no JWT to
   * carry organizationId. branchId is required here so the lead lands in
   * the right tenant; without it the request cannot be routed.
   */
  async capturePublic(dto: CaptureLeadDto) {
    if (!dto.branchId) {
      throw new BadRequestException('branchId is required');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, status: 'ACTIVE', deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!branch) throw new BadRequestException('Unknown branch');
    const lead = await this.prisma.lead.create({
      data: {
        organizationId: branch.organizationId,
        branchId: branch.id,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        email: dto.email,
        source: dto.source ?? 'WEB_FORM',
        status: 'NEW',
      },
    });
    await this.prisma.leadSourceEvent.create({
      data: {
        organizationId: branch.organizationId,
        leadId: lead.id,
        channel: 'WEB_FORM',
        payload: {
          ...(dto.source ? { source: dto.source } : {}),
          ...(dto.phone ? { phone: dto.phone } : {}),
          ...(dto.email ? { email: dto.email } : {}),
        },
      },
    });
    const created: LeadCreatedEvent = {
      organizationId: branch.organizationId,
      leadId: lead.id,
      branchId: branch.id,
      channel: 'WEB_FORM',
    };
    this.events.emit(DomainEvent.LeadCreated, created);
    return lead;
  }

  /**
   * Bulk import (POST /leads/import). Every row becomes a NEW lead with an
   * IMPORT source event; the whole batch shares the caller's tenant.
   */
  async importLeads(
    organizationId: string,
    dto: ImportLeadsDto,
    branchScope: string | null = null,
  ) {
    if (!dto.leads?.length) {
      throw new BadRequestException('leads must be a non-empty array');
    }
    if (dto.leads.length > 500) {
      throw new BadRequestException('A maximum of 500 leads per import');
    }
    const created: { id: string }[] = [];
    for (const row of dto.leads) {
      const branchId = row.branchId ?? branchScope ?? undefined;
      if (branchScope && row.branchId && row.branchId !== branchScope) {
        throw new BadRequestException(
          'Cannot import a lead outside your assigned branch',
        );
      }
      await this.validateReferences(organizationId, branchId, undefined);
      const lead = await this.prisma.lead.create({
        data: {
          organizationId,
          firstName: row.firstName,
          lastName: row.lastName,
          phone: row.phone,
          email: row.email,
          source: row.source ?? 'IMPORT',
          notes: row.notes,
          branchId,
          status: 'NEW',
        },
      });
      await this.prisma.leadSourceEvent.create({
        data: {
          organizationId,
          leadId: lead.id,
          channel: 'IMPORT',
          payload: row.source ? { source: row.source } : undefined,
        },
      });
      const event: LeadCreatedEvent = {
        organizationId,
        leadId: lead.id,
        branchId: lead.branchId,
        channel: 'IMPORT',
      };
      this.events.emit(DomainEvent.LeadCreated, event);
      created.push({ id: lead.id });
    }
    return { imported: created.length, leads: created };
  }

  /**
   * Speed-to-lead SLA (GET /crm/sla). Pure computation, no new columns:
   * the clock starts at the earliest LeadSourceEvent (falling back to
   * Lead.createdAt for pre-WS-3 rows); first contact is the earliest of
   * the first completed LeadFollowUp or the first outbound SENT-class
   * MessageLog addressed to the lead's phone.
   */
  async getSla(organizationId: string, branchScope: string | null = null) {
    const leads = await this.prisma.lead.findMany({
      where: {
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        createdAt: true,
        followUps: {
          where: { completedAt: { not: null } },
          select: { completedAt: true },
          orderBy: { completedAt: 'asc' },
          take: 1,
        },
        sourceEvents: {
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    const phones = [
      ...new Set(leads.map((l) => l.phone).filter(Boolean)),
    ] as string[];
    const logsByRecipient = new Map<string, Date>();
    if (phones.length > 0) {
      const logs = await this.prisma.messageLog.findMany({
        where: {
          organizationId,
          recipient: { in: phones },
          status: { in: ['SENT', 'DELIVERED', 'READ'] },
        },
        select: { recipient: true, sentAt: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const log of logs) {
        if (!logsByRecipient.has(log.recipient)) {
          logsByRecipient.set(log.recipient, log.sentAt ?? log.createdAt);
        }
      }
    }
    const now = Date.now();
    const items = leads.map((lead) => {
      const startAt = lead.sourceEvents[0]?.createdAt ?? lead.createdAt;
      const followUpAt = lead.followUps[0]?.completedAt ?? null;
      const logAt =
        lead.phone && logsByRecipient.has(lead.phone)
          ? logsByRecipient.get(lead.phone)!
          : null;
      const firstContactAt =
        followUpAt && logAt
          ? new Date(Math.min(followUpAt.getTime(), logAt.getTime()))
          : (followUpAt ?? logAt ?? null);
      const slaMin = firstContactAt
        ? Math.round((firstContactAt.getTime() - startAt.getTime()) / 60000)
        : undefined;
      return {
        leadId: lead.id,
        name: `${lead.firstName} ${lead.lastName}`,
        createdAt: startAt.toISOString(),
        ...(firstContactAt
          ? { firstContactAt: firstContactAt.toISOString() }
          : {}),
        ...(slaMin !== undefined ? { slaMin } : {}),
      };
    });
    const overdueCount = items.filter((item) => {
      if (item.firstContactAt) return false;
      return now - new Date(item.createdAt).getTime() > 120 * 60 * 1000;
    }).length;
    const contacted = items
      .map((i) => i.slaMin)
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    const medianMin =
      contacted.length === 0
        ? null
        : contacted.length % 2 === 1
          ? contacted[Math.floor(contacted.length / 2)]
          : Math.round(
              (contacted[contacted.length / 2 - 1] +
                contacted[contacted.length / 2]) /
                2,
            );
    return { items, overdueCount, medianMin };
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
    if (dto.status === 'LOST' && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to mark a lead lost');
    }
    return this.prisma.lead.update({
      where: { id },
      data: {
        status: dto.status,
        // Capture the loss reason on LOST; clear it when the lead is
        // re-opened so a stale reason never attributes to a later loss.
        lostReason: dto.status === 'LOST' ? dto.reason!.trim() : null,
      },
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

  /**
   * Deterministic lead score (0-100, HOT >= 70, WARM >= 40, else COLD).
   * Rule-based from real rows -- recency, pipeline stage, follow-up
   * discipline, contactability -- not an ML model; every point is
   * explained in `factors` so the CRM badge tooltip can show its work.
   * Formula: base 50; recency +20 (<=3d) / +10 (<=7d) / +0 (<=30d) /
   * -10 (older); stage +0 NEW / +5 CONTACTED / +10 QUALIFIED / +15
   * TRIAL; engagement +15 (>=1 completed follow-up) / +5 (any follow-up,
   * none completed); contactability +5 (email or phone on file);
   * staleness -15 (no follow-up at all and created >14d ago). Clamped
   * 0-100. WON/LOST leads still score (history view), but the grade is
   * informational -- the pipeline already decided them.
   */
  async getScore(organizationId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, organizationId },
      include: { followUps: { select: { completedAt: true } } },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const factors: { label: string; points: number }[] = [];
    let score = 50;
    const push = (label: string, points: number) => {
      score += points;
      factors.push({ label, points });
    };

    const ageDays = (Date.now() - lead.createdAt.getTime()) / MS_PER_DAY;
    if (ageDays <= 3) push('New lead (<= 3 days old)', 20);
    else if (ageDays <= 7) push('Recent lead (<= 7 days old)', 10);
    else if (ageDays > 30) push('Ageing lead (> 30 days old)', -10);

    const stagePoints: Record<string, number> = {
      NEW: 0,
      CONTACTED: 5,
      QUALIFIED: 10,
      TRIAL: 15,
      WON: 0,
      LOST: 0,
    };
    push(`Pipeline stage: ${lead.status}`, stagePoints[lead.status] ?? 0);

    const completed = lead.followUps.filter(
      (f) => f.completedAt !== null,
    ).length;
    if (completed > 0) push(`${completed} follow-up(s) completed`, 15);
    else if (lead.followUps.length > 0)
      push('Follow-ups scheduled, none completed yet', 5);

    if (lead.email || lead.phone) push('Contact details on file', 5);

    if (lead.followUps.length === 0 && ageDays > 14)
      push('No follow-up scheduled in 14+ days', -15);

    score = Math.min(100, Math.max(0, Math.round(score)));
    return {
      leadId: lead.id,
      score,
      grade: (score >= 70 ? 'HOT' : score >= 40 ? 'WARM' : 'COLD') as
        'HOT' | 'WARM' | 'COLD',
      factors,
    };
  }

  /**
   * Staff-composed one-off message to a lead (the CRM "quick outreach"
   * box). Same honesty as member sends: EMAIL delivers via SMTP,
   * WHATSAPP records a FAILED log row until a real provider is wired.
   * Returns the MessageLog row; the lead itself is unchanged (the
   * controller's response type is the log, despite the frontend's
   * optimistic Lead typing -- the log carries the delivery truth).
   */
  async sendMessage(
    organizationId: string,
    leadId: string,
    dto: SendLeadMessageDto,
    branchScope: string | null = null,
  ) {
    const lead = await this.getOne(organizationId, leadId, branchScope);
    const recipient =
      dto.channel === 'EMAIL' ? (lead.email ?? '') : (lead.phone ?? '');
    if (!recipient)
      throw new BadRequestException(
        dto.channel === 'EMAIL'
          ? 'This lead has no email address on file'
          : 'This lead has no phone number on file',
      );
    return this.communications.sendAdHoc({
      organizationId,
      channel: dto.channel,
      category: 'TRANSACTIONAL',
      recipient,
      subject: dto.subject,
      body: dto.customBody.trim(),
    });
  }

  /**
   * Global follow-up worklist across all leads (the CRM follow-ups
   * page), newest-due first within open/completed groups. `status`:
   * OPEN (default) / COMPLETED / ALL.
   */
  async listFollowUps(
    organizationId: string,
    query: {
      page?: number;
      pageSize?: number;
      status?: 'OPEN' | 'COMPLETED' | 'ALL';
      from?: string;
      to?: string;
    },
    branchScope: string | null = null,
  ) {
    const status = query.status ?? 'OPEN';
    const where: Prisma.LeadFollowUpWhereInput = {
      organizationId,
      ...(status === 'OPEN'
        ? { completedAt: null }
        : status === 'COMPLETED'
          ? { completedAt: { not: null } }
          : {}),
      ...(query.from || query.to
        ? {
            dueAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(branchScope
        ? { lead: { branchId: branchScope } }
        : { lead: { organizationId } }),
    };
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize =
      query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 20;
    const [items, total] = await Promise.all([
      this.prisma.leadFollowUp.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ completedAt: 'asc' }, { dueAt: 'asc' }],
        include: {
          lead: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
              source: true,
              status: true,
              assignedToUser: {
                select: { id: true, firstName: true, lastName: true },
              },
            },
          },
          createdByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.leadFollowUp.count({ where }),
    ]);
    const rows = items.map((item) => ({
      ...item,
      isOverdue: item.completedAt === null && item.dueAt.getTime() < Date.now(),
    }));
    return paginate(rows, total, page, pageSize);
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
