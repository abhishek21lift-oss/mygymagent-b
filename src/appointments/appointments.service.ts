import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { paginate } from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AddTimeOffDto,
  CalendarQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  RescheduleAppointmentDto,
  SetAvailabilityRuleDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';

const INCLUDE = {
  branch: { select: { id: true, name: true } },
  staff: { select: { id: true, firstName: true, lastName: true } },
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
    },
  },
  lead: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
    },
  },
} as const;

/**
 * Gym calendar: generic bookings (trial, consultation, assessment,
 * follow-up) plus trainer availability and time off. PT sessions stay
 * in their own store (src/pt-sessions/) -- the calendar FEED merges
 * them read-only so the calendar page shows one timeline without a
 * second writable PT copy.
 *
 * Same-STAFF overlaps are rejected (a trainer cannot be in two places);
 * same-member overlaps are allowed (back-to-back trial + consultation
 * is a legitimate front-desk flow, and blocking it would create false
 * conflicts when the member record is shared across branches).
 */
@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private assignmentFilter(assignmentScope: string | null) {
    return assignmentScope
      ? {
          OR: [
            { staffId: assignmentScope },
            { member: { assignedTrainerId: assignmentScope } },
          ],
        }
      : {};
  }

  private async validateReferences(
    organizationId: string,
    dto: {
      branchId?: string;
      staffId?: string | null;
      memberId?: string | null;
      leadId?: string | null;
    },
  ) {
    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: {
          id: dto.branchId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!branch)
        throw new BadRequestException(
          'Branch does not belong to this organization',
        );
    }
    if (dto.staffId) {
      const staff = await this.prisma.user.findFirst({
        where: { id: dto.staffId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!staff)
        throw new BadRequestException(
          'Staff member does not belong to this organization',
        );
    }
    if (dto.memberId) {
      const member = await this.prisma.member.findFirst({
        where: { id: dto.memberId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!member)
        throw new BadRequestException(
          'Member does not belong to this organization',
        );
    }
    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, organizationId },
        select: { id: true },
      });
      if (!lead)
        throw new BadRequestException(
          'Lead does not belong to this organization',
        );
    }
  }

  private async assertNoStaffOverlap(
    organizationId: string,
    staffId: string,
    start: Date,
    end: Date,
    ignoreId?: string,
  ) {
    const clash = await this.prisma.appointment.findFirst({
      where: {
        organizationId,
        staffId,
        status: { in: ['BOOKED', 'RESCHEDULED'] },
        ...(ignoreId ? { id: { not: ignoreId } } : {}),
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { id: true, title: true, startTime: true },
    });
    if (clash)
      throw new BadRequestException(
        `Trainer is already booked at this time (${clash.title})`,
      );
  }

  async list(
    organizationId: string,
    query: ListAppointmentsQueryDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const where: Prisma.AppointmentWhereInput = {
      organizationId,
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.staffId ? { staffId: query.staffId } : {}),
      ...(query.type ? { type: query.type as never } : {}),
      ...(branchScope || query.branchId
        ? { branchId: branchScope ?? query.branchId! }
        : {}),
      ...(query.from || query.to
        ? {
            startTime: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...this.assignmentFilter(assignmentScope),
    };
    const [items, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { startTime: query.order ?? 'asc' },
        include: INCLUDE,
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...this.assignmentFilter(assignmentScope),
      },
      include: INCLUDE,
    });
    if (!appointment) throw new NotFoundException('Appointment not found');
    return appointment;
  }

  async create(
    organizationId: string,
    dto: CreateAppointmentDto,
    createdByUserId: string,
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId !== branchScope)
      throw new BadRequestException(
        'Cannot book an appointment outside your assigned branch',
      );
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (!(start < end))
      throw new BadRequestException('endTime must be after startTime');
    await this.validateReferences(organizationId, dto);
    if (dto.staffId)
      await this.assertNoStaffOverlap(organizationId, dto.staffId, start, end);
    return this.prisma.appointment.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        staffId: dto.staffId,
        memberId: dto.memberId,
        leadId: dto.leadId,
        type: dto.type as never,
        title: dto.title.trim(),
        startTime: start,
        endTime: end,
        notes: dto.notes,
        clientName: dto.clientName,
        clientEmail: dto.clientEmail,
        clientPhone: dto.clientPhone,
        createdByUserId,
      },
      include: INCLUDE,
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateAppointmentDto,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED')
      throw new BadRequestException(
        'Completed or cancelled appointments cannot be edited. Reschedule or re-book instead.',
      );
    await this.validateReferences(organizationId, {
      branchId: undefined,
      staffId: dto.staffId,
      memberId: dto.memberId,
      leadId: dto.leadId,
    });
    const start = dto.startTime ? new Date(dto.startTime) : existing.startTime;
    const end = dto.endTime ? new Date(dto.endTime) : existing.endTime;
    if (!(start < end))
      throw new BadRequestException('endTime must be after startTime');
    const staffId = dto.staffId !== undefined ? dto.staffId : existing.staffId;
    if (staffId)
      await this.assertNoStaffOverlap(organizationId, staffId, start, end, id);
    return this.prisma.appointment.update({
      where: { id },
      data: {
        ...(dto.staffId !== undefined ? { staffId: dto.staffId } : {}),
        ...(dto.memberId !== undefined ? { memberId: dto.memberId } : {}),
        ...(dto.leadId !== undefined ? { leadId: dto.leadId } : {}),
        ...(dto.type ? { type: dto.type as never } : {}),
        ...(dto.title ? { title: dto.title.trim() } : {}),
        startTime: start,
        endTime: end,
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.clientName !== undefined ? { clientName: dto.clientName } : {}),
        ...(dto.clientEmail !== undefined
          ? { clientEmail: dto.clientEmail }
          : {}),
        ...(dto.clientPhone !== undefined
          ? { clientPhone: dto.clientPhone }
          : {}),
      },
      include: INCLUDE,
    });
  }

  async reschedule(
    organizationId: string,
    id: string,
    dto: RescheduleAppointmentDto,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED')
      throw new BadRequestException(
        'Completed or cancelled appointments cannot be rescheduled',
      );
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (!(start < end))
      throw new BadRequestException('endTime must be after startTime');
    if (existing.staffId)
      await this.assertNoStaffOverlap(
        organizationId,
        existing.staffId,
        start,
        end,
        id,
      );
    return this.prisma.appointment.update({
      where: { id },
      data: {
        startTime: start,
        endTime: end,
        status: 'RESCHEDULED',
        notes: dto.reason
          ? `${existing.notes ? `${existing.notes}\n` : ''}Rescheduled: ${dto.reason}`
          : existing.notes,
      },
      include: INCLUDE,
    });
  }

  async cancel(
    organizationId: string,
    id: string,
    dto: CancelAppointmentDto,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'CANCELLED')
      throw new BadRequestException('Appointment is already cancelled');
    if (existing.status === 'COMPLETED')
      throw new BadRequestException(
        'Completed appointments cannot be cancelled',
      );
    return this.prisma.appointment.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancellationReason: dto.reason,
      },
      include: INCLUDE,
    });
  }

  async complete(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'COMPLETED')
      throw new BadRequestException('Appointment is already completed');
    if (existing.status === 'CANCELLED')
      throw new BadRequestException(
        'Cancelled appointments cannot be completed',
      );
    return this.prisma.appointment.update({
      where: { id },
      data: { status: 'COMPLETED' },
      include: INCLUDE,
    });
  }

  async noShow(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED')
      throw new BadRequestException(
        'Completed or cancelled appointments cannot be marked no-show',
      );
    return this.prisma.appointment.update({
      where: { id },
      data: { status: 'NO_SHOW' },
      include: INCLUDE,
    });
  }

  /**
   * Merged calendar feed: appointments plus PT sessions in the window.
   * PT rows are read-only projections (source PT_SESSION) -- the
   * writable PT store stays in src/pt-sessions/.
   */
  async calendarFeed(
    organizationId: string,
    query: CalendarQueryDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to
      ? new Date(query.to)
      : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    const branchId = branchScope ?? query.branchId;

    const appointments = await this.prisma.appointment.findMany({
      where: {
        organizationId,
        startTime: { gte: from, lte: to },
        ...(branchId ? { branchId } : {}),
        ...(query.staffId ? { staffId: query.staffId } : {}),
        ...(query.memberId ? { memberId: query.memberId } : {}),
        ...(query.leadId ? { leadId: query.leadId } : {}),
        status: { notIn: ['CANCELLED'] },
        ...this.assignmentFilter(assignmentScope),
      },
      orderBy: { startTime: 'asc' },
      take: 500,
      include: {
        staff: { select: { id: true, firstName: true, lastName: true } },
        member: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const ptSessions = await this.prisma.ptSession.findMany({
      where: {
        organizationId,
        startTime: { gte: from, lte: to },
        ...(branchId ? { branchId } : {}),
        ...(query.memberId ? { memberId: query.memberId } : {}),
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      orderBy: { startTime: 'asc' },
      take: 500,
      include: {
        member: { select: { id: true, firstName: true, lastName: true } },
        trainer: {
          select: {
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    const slots = [
      ...appointments.map((a) => ({
        id: a.id,
        source: 'APPOINTMENT',
        type: a.type,
        status: a.status,
        title: a.title,
        startTime: a.startTime.toISOString(),
        endTime: a.endTime.toISOString(),
        branchId: a.branchId,
        staffId: a.staffId,
        staffName: a.staff ? `${a.staff.firstName} ${a.staff.lastName}` : null,
        memberId: a.memberId,
        memberName: a.member
          ? `${a.member.firstName} ${a.member.lastName}`
          : (a.clientName ?? null),
        leadId: a.leadId,
        notes: a.notes,
      })),
      ...ptSessions.map((s) => ({
        id: s.id,
        source: 'PT_SESSION',
        type: s.type,
        status: s.status,
        title: `PT: ${s.member.firstName} ${s.member.lastName}`,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        branchId: s.branchId,
        staffId: s.trainer?.user?.id ?? null,
        staffName: s.trainer?.user
          ? `${s.trainer.user.firstName} ${s.trainer.user.lastName}`
          : null,
        memberId: s.memberId,
        memberName: `${s.member.firstName} ${s.member.lastName}`,
        leadId: null,
        notes: s.notes,
      })),
    ];
    slots.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    return slots;
  }

  listAvailabilityRules(organizationId: string, staffId?: string) {
    return this.prisma.trainerAvailabilityRule.findMany({
      where: {
        organizationId,
        ...(staffId ? { staffId } : {}),
      },
      orderBy: [{ staffId: 'asc' }, { dayOfWeek: 'asc' }],
      include: {
        staff: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async setAvailabilityRule(
    organizationId: string,
    dto: SetAvailabilityRuleDto,
  ) {
    const staff = await this.prisma.user.findFirst({
      where: { id: dto.staffId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!staff)
      throw new BadRequestException(
        'Staff member does not belong to this organization',
      );
    if (!(dto.startMinute < dto.endMinute))
      throw new BadRequestException('endMinute must be after startMinute');
    const existing = await this.prisma.trainerAvailabilityRule.findFirst({
      where: {
        organizationId,
        staffId: dto.staffId,
        dayOfWeek: dto.dayOfWeek,
        branchId: dto.branchId ?? null,
      },
    });
    if (existing) {
      return this.prisma.trainerAvailabilityRule.update({
        where: { id: existing.id },
        data: {
          startMinute: dto.startMinute,
          endMinute: dto.endMinute,
          isActive: true,
        },
      });
    }
    return this.prisma.trainerAvailabilityRule.create({
      data: {
        organizationId,
        staffId: dto.staffId,
        branchId: dto.branchId,
        dayOfWeek: dto.dayOfWeek,
        startMinute: dto.startMinute,
        endMinute: dto.endMinute,
      },
    });
  }

  async deleteAvailabilityRule(organizationId: string, id: string) {
    const rule = await this.prisma.trainerAvailabilityRule.findFirst({
      where: { id, organizationId },
    });
    if (!rule) throw new NotFoundException('Availability rule not found');
    await this.prisma.trainerAvailabilityRule.delete({ where: { id } });
    return { ok: true };
  }

  listTimeOffs(organizationId: string, staffId?: string) {
    return this.prisma.trainerTimeOff.findMany({
      where: {
        organizationId,
        ...(staffId ? { staffId } : {}),
      },
      orderBy: { startAt: 'asc' },
      include: {
        staff: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async addTimeOff(organizationId: string, dto: AddTimeOffDto) {
    const staff = await this.prisma.user.findFirst({
      where: { id: dto.staffId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!staff)
      throw new BadRequestException(
        'Staff member does not belong to this organization',
      );
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (!(start < end))
      throw new BadRequestException('endAt must be after startAt');
    await this.prisma.trainerTimeOff.create({
      data: {
        organizationId,
        staffId: dto.staffId,
        branchId: dto.branchId,
        reason: dto.reason,
        startAt: start,
        endAt: end,
      },
    });
    return { ok: true };
  }

  async deleteTimeOff(organizationId: string, id: string) {
    const row = await this.prisma.trainerTimeOff.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException('Time off not found');
    await this.prisma.trainerTimeOff.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Free bookable windows for one trainer on one UTC day (YYYY-MM-DD),
   * from availability rules minus appointments and time off. When the
   * trainer has no rules at all the windows are empty with an
   * explanatory note -- never fabricated "9 to 5" defaults.
   */
  async freeSlots(organizationId: string, staffId: string, day: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!staff) throw new NotFoundException('Staff member not found');

    const dayStart = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime()))
      throw new BadRequestException('day must be YYYY-MM-DD');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayOfWeek = dayStart.getUTCDay();

    const [rules, appointments, timeOffs] = await Promise.all([
      this.prisma.trainerAvailabilityRule.findMany({
        where: { organizationId, staffId, dayOfWeek, isActive: true },
      }),
      this.prisma.appointment.findMany({
        where: {
          organizationId,
          staffId,
          status: { in: ['BOOKED', 'RESCHEDULED'] },
          startTime: { lt: dayEnd },
          endTime: { gt: dayStart },
        },
        select: { startTime: true, endTime: true },
      }),
      this.prisma.trainerTimeOff.findMany({
        where: {
          organizationId,
          staffId,
          startAt: { lt: dayEnd },
          endAt: { gt: dayStart },
        },
        select: { startAt: true, endAt: true },
      }),
    ]);

    if (rules.length === 0) {
      return {
        staffId,
        windows: [],
        note: 'No availability rules set for this trainer',
      };
    }

    const busy = [
      ...appointments.map((a) => ({ start: a.startTime, end: a.endTime })),
      ...timeOffs.map((t) => ({ start: t.startAt, end: t.endAt })),
    ].sort((a, b) => a.start.getTime() - b.start.getTime());

    const toIso = (d: Date) => d.toISOString();
    const windows = rules.map((rule) => {
      const windowStart = new Date(
        dayStart.getTime() + rule.startMinute * 60 * 1000,
      );
      const windowEnd = new Date(
        dayStart.getTime() + rule.endMinute * 60 * 1000,
      );
      const free: { start: string; end: string }[] = [];
      let cursor = windowStart;
      for (const block of busy) {
        if (block.end <= cursor || block.start >= windowEnd) continue;
        if (block.start > cursor) {
          free.push({ start: toIso(cursor), end: toIso(block.start) });
        }
        if (block.end > cursor) cursor = block.end;
      }
      if (cursor < windowEnd) {
        free.push({ start: toIso(cursor), end: toIso(windowEnd) });
      }
      return {
        start: toIso(windowStart),
        end: toIso(windowEnd),
        free,
      };
    });

    return { staffId, windows };
  }
}
