import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Slot windows for the unified calendar: appointments in [from, to) plus
 * PtSession rows (SCHEDULED/COMPLETED) projected into the same feed. The
 * appointments module never writes PtSessions -- pt-sessions stays the
 * single writer; this service only reads.
 */
const MS_PER_MINUTE = 60_000;

export interface CalendarSlot {
  id: string;
  source: 'APPOINTMENT' | 'PT_SESSION';
  type: string;
  status: string;
  title: string;
  startTime: Date;
  endTime: Date;
  branchId: string;
  staffId: string | null;
  staffName: string | null;
  memberId: string | null;
  memberName: string | null;
  leadId: string | null;
  notes: string | null;
}

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Unified calendar feed
  // ------------------------------------------------------------------

  async calendar(
    organizationId: string,
    from: Date,
    to: Date,
    filters: {
      branchId?: string;
      staffId?: string;
      memberId?: string;
      leadId?: string;
    },
    branchScope: string | null = null,
  ): Promise<CalendarSlot[]> {
    const effBranchId = filters.branchId ?? branchScope ?? undefined;
    const [appointments, ptSessions] = await Promise.all([
      this.prisma.appointment.findMany({
        where: {
          organizationId,
          startTime: { lt: to },
          endTime: { gt: from },
          ...(effBranchId ? { branchId: effBranchId } : {}),
          ...(filters.staffId ? { staffId: filters.staffId } : {}),
          ...(filters.memberId ? { memberId: filters.memberId } : {}),
          ...(filters.leadId ? { leadId: filters.leadId } : {}),
        },
        include: {
          staff: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { startTime: 'asc' },
      }),
      this.prisma.ptSession.findMany({
        where: {
          organizationId,
          startTime: { lt: to },
          endTime: { gt: from },
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          ...(effBranchId ? { branchId: effBranchId } : {}),
          ...(filters.staffId ? { trainerId: filters.staffId } : {}),
          ...(filters.memberId ? { memberId: filters.memberId } : {}),
        },
        include: {
          trainer: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          member: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { startTime: 'asc' },
      }),
    ]);

    const slots: CalendarSlot[] = [
      ...appointments.map((a) => ({
        id: a.id,
        source: 'APPOINTMENT' as const,
        type: a.type,
        status: a.status,
        title: a.title,
        startTime: a.startTime,
        endTime: a.endTime,
        branchId: a.branchId,
        staffId: a.staffId,
        staffName: a.staff?.user
          ? `${a.staff.user.firstName} ${a.staff.user.lastName}`
          : null,
        memberId: a.memberId,
        memberName: a.member
          ? `${a.member.firstName} ${a.member.lastName}`
          : null,
        leadId: a.leadId,
        notes: a.notes,
      })),
      ...ptSessions.map((s) => ({
        id: s.id,
        source: 'PT_SESSION' as const,
        type: s.type,
        status: s.status,
        title: 'PT session',
        startTime: s.startTime,
        endTime: s.endTime,
        branchId: s.branchId,
        staffId: s.trainerId,
        staffName: s.trainer?.user
          ? `${s.trainer.user.firstName} ${s.trainer.user.lastName}`
          : null,
        memberId: s.memberId,
        memberName: s.member
          ? `${s.member.firstName} ${s.member.lastName}`
          : null,
        leadId: null,
        notes: s.notes,
      })),
    ];
    slots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return slots;
  }

  // ------------------------------------------------------------------
  // Conflict detection (shared by create/reschedule)
  // ------------------------------------------------------------------

  private async assertNoConflicts(
    organizationId: string,
    window: { startTime: Date; endTime: Date },
    participants: {
      staffId?: string | null;
      memberId?: string | null;
      branchId: string;
    },
    excludeAppointmentId?: string,
  ) {
    // Staff double-booking: any appointment or PT session overlapping the
    // window for the same staff member.
    if (participants.staffId) {
      const [staffAppt, staffPt] = await Promise.all([
        this.prisma.appointment.findFirst({
          where: {
            organizationId,
            staffId: participants.staffId,
            id: excludeAppointmentId
              ? { not: excludeAppointmentId }
              : undefined,
            status: 'BOOKED',
            startTime: { lt: window.endTime },
            endTime: { gt: window.startTime },
          },
        }),
        this.prisma.ptSession.findFirst({
          where: {
            organizationId,
            trainerId: participants.staffId,
            status: 'SCHEDULED',
            startTime: { lt: window.endTime },
            endTime: { gt: window.startTime },
          },
        }),
      ]);
      if (staffAppt || staffPt) {
        throw new BadRequestException(
          'Selected staff member already has a booking in this time window',
        );
      }
    }

    // Member double-booking across appointments and PT sessions.
    if (participants.memberId) {
      const [memberAppt, memberPt] = await Promise.all([
        this.prisma.appointment.findFirst({
          where: {
            organizationId,
            memberId: participants.memberId,
            id: excludeAppointmentId
              ? { not: excludeAppointmentId }
              : undefined,
            status: 'BOOKED',
            startTime: { lt: window.endTime },
            endTime: { gt: window.startTime },
          },
        }),
        this.prisma.ptSession.findFirst({
          where: {
            organizationId,
            memberId: participants.memberId,
            status: 'SCHEDULED',
            startTime: { lt: window.endTime },
            endTime: { gt: window.startTime },
          },
        }),
      ]);
      if (memberAppt || memberPt) {
        throw new BadRequestException(
          'Member already has a booking in this time window',
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Availability validation
  // ------------------------------------------------------------------

  private async assertWithinAvailability(
    organizationId: string,
    staffId: string,
    branchId: string,
    window: { startTime: Date; endTime: Date },
  ) {
    // Time-off blocks any booking regardless of weekly rules.
    const timeOff = await this.prisma.trainerTimeOff.findFirst({
      where: {
        organizationId,
        staffId,
        OR: [{ branchId: null }, { branchId }],
        startAt: { lt: window.endTime },
        endAt: { gt: window.startTime },
      },
    });
    if (timeOff) {
      throw new BadRequestException(
        'Staff member is on time off during the requested window',
      );
    }

    // If the trainer has any active rules, the slot must fall inside one.
    const rules = await this.prisma.trainerAvailabilityRule.findMany({
      where: { organizationId, staffId, isActive: true },
    });
    if (rules.length === 0) return;

    const startMinute =
      window.startTime.getUTCHours() * 60 + window.startTime.getUTCMinutes();
    const endMinute =
      window.endTime.getUTCHours() * 60 + window.endTime.getUTCMinutes();
    const startDow =
      window.startTime.getUTCDay() === 0 ? 7 : window.startTime.getUTCDay();
    const endDow =
      window.endTime.getUTCDay() === 0 ? 7 : window.endTime.getUTCDay();

    const ok = rules.some((rule) => {
      const branchOk = !rule.branchId || rule.branchId === branchId;
      const startOk =
        startDow === rule.dayOfWeek &&
        startMinute >= rule.startMinute &&
        startMinute < rule.endMinute;
      const endOk =
        endDow === rule.dayOfWeek &&
        endMinute > rule.startMinute &&
        endMinute <= rule.endMinute;
      return branchOk && startOk && endOk;
    });
    if (!ok) {
      throw new BadRequestException(
        "Booking window falls outside the staff member's availability rules",
      );
    }
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  async list(
    organizationId: string,
    query: {
      memberId?: string;
      leadId?: string;
      staffId?: string;
      branchId?: string;
      from?: Date;
      to?: Date;
      page?: number;
      pageSize?: number;
    },
    branchScope: string | null = null,
  ) {
    const where: Prisma.AppointmentWhereInput = {
      organizationId,
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.staffId ? { staffId: query.staffId } : {}),
      ...(query.branchId || branchScope
        ? { branchId: query.branchId ?? branchScope! }
        : {}),
      ...(query.from && query.to
        ? { startTime: { gte: query.from }, endTime: { lte: query.to } }
        : {}),
      ...(query.from && !query.to ? { startTime: { gte: query.from } } : {}),
      ...(!query.from && query.to ? { endTime: { lte: query.to } } : {}),
    };
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 50, 200);
    const [items, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        orderBy: { startTime: 'desc' },
        take: pageSize,
        skip: (page - 1) * pageSize,
        include: {
          staff: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          member: { select: { id: true, firstName: true, lastName: true } },
          lead: { select: { id: true, firstName: true, lastName: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return {
      items,
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize) || 1,
    };
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: {
        staff: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
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
        branch: { select: { id: true, name: true } },
      },
    });
    if (!appointment) throw new NotFoundException('Appointment not found');
    return appointment;
  }

  async create(
    organizationId: string,
    dto: {
      branchId: string;
      staffId?: string;
      memberId?: string;
      leadId?: string;
      type: string;
      title: string;
      startTime: string;
      endTime: string;
      notes?: string;
      clientName?: string;
      clientEmail?: string;
      clientPhone?: string;
    },
    createdByUserId: string,
    branchScope: string | null = null,
  ) {
    if (branchScope && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Appointment can only be booked for a branch you manage',
      );
    }
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    if (startTime >= endTime) {
      throw new BadRequestException('End time must be after start time');
    }

    // Referential validation.
    const [branch, staff, member, lead] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: dto.branchId, organizationId },
      }),
      dto.staffId
        ? this.prisma.staffProfile.findFirst({
            where: { id: dto.staffId, organizationId },
          })
        : Promise.resolve(null),
      dto.memberId
        ? this.prisma.member.findFirst({
            where: { id: dto.memberId, organizationId, deletedAt: null },
          })
        : Promise.resolve(null),
      dto.leadId
        ? this.prisma.lead.findFirst({
            where: { id: dto.leadId, organizationId },
          })
        : Promise.resolve(null),
    ]);
    if (!branch)
      throw new BadRequestException('Branch not found in this organization');
    if (dto.staffId && !staff)
      throw new BadRequestException(
        'Staff member not found in this organization',
      );
    if (dto.memberId && !member)
      throw new BadRequestException('Member not found in this organization');
    if (dto.leadId && !lead)
      throw new BadRequestException('Lead not found in this organization');

    // Availability + conflicts.
    if (dto.staffId) {
      await this.assertWithinAvailability(
        organizationId,
        dto.staffId,
        dto.branchId,
        {
          startTime,
          endTime,
        },
      );
      await this.assertNoConflicts(
        organizationId,
        { startTime, endTime },
        {
          staffId: dto.staffId,
          memberId: dto.memberId,
          branchId: dto.branchId,
        },
      );
    } else {
      await this.assertNoConflicts(
        organizationId,
        { startTime, endTime },
        {
          memberId: dto.memberId,
          branchId: dto.branchId,
        },
      );
    }

    // Client contact snapshot for reminders.
    const clientName =
      dto.clientName ??
      (member
        ? `${member.firstName} ${member.lastName}`
        : lead
          ? `${lead.firstName} ${lead.lastName}`
          : null);
    const clientEmail = dto.clientEmail ?? member?.email ?? lead?.email ?? null;
    const clientPhone = dto.clientPhone ?? member?.phone ?? lead?.phone ?? null;

    return this.prisma.appointment.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        staffId: dto.staffId ?? null,
        memberId: dto.memberId ?? null,
        leadId: dto.leadId ?? null,
        type: dto.type as never,
        title: dto.title,
        startTime,
        endTime,
        notes: dto.notes ?? null,
        clientName,
        clientEmail,
        clientPhone,
        createdByUserId,
      },
      include: {
        staff: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        branch: { select: { id: true, name: true } },
      },
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: {
      title?: string;
      startTime?: string;
      endTime?: string;
      notes?: string;
    },
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'BOOKED') {
      throw new BadRequestException(
        `Cannot edit a ${existing.status} appointment`,
      );
    }
    const startTime = dto.startTime
      ? new Date(dto.startTime)
      : existing.startTime;
    const endTime = dto.endTime ? new Date(dto.endTime) : existing.endTime;
    if (startTime >= endTime) {
      throw new BadRequestException('End time must be after start time');
    }
    const timeChanged =
      (dto.startTime &&
        new Date(dto.startTime).getTime() !== existing.startTime.getTime()) ||
      (dto.endTime &&
        new Date(dto.endTime).getTime() !== existing.endTime.getTime());
    if (timeChanged) {
      if (existing.staffId) {
        await this.assertWithinAvailability(
          organizationId,
          existing.staffId,
          existing.branchId,
          {
            startTime,
            endTime,
          },
        );
      }
      await this.assertNoConflicts(
        organizationId,
        { startTime, endTime },
        {
          staffId: existing.staffId,
          memberId: existing.memberId,
          branchId: existing.branchId,
        },
        id,
      );
    }
    return this.prisma.appointment.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.startTime !== undefined ? { startTime } : {}),
        ...(dto.endTime !== undefined ? { endTime } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  async reschedule(
    organizationId: string,
    id: string,
    dto: { startTime: string; endTime: string; reason?: string },
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'BOOKED') {
      throw new BadRequestException(
        `Cannot reschedule a ${existing.status} appointment`,
      );
    }
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    if (startTime >= endTime) {
      throw new BadRequestException('End time must be after start time');
    }
    if (existing.staffId) {
      await this.assertWithinAvailability(
        organizationId,
        existing.staffId,
        existing.branchId,
        {
          startTime,
          endTime,
        },
      );
    }
    await this.assertNoConflicts(
      organizationId,
      { startTime, endTime },
      {
        staffId: existing.staffId,
        memberId: existing.memberId,
        branchId: existing.branchId,
      },
      id,
    );
    return this.prisma.appointment.update({
      where: { id },
      data: {
        startTime,
        endTime,
        notes: dto.reason
          ? `${existing.notes ? existing.notes + ' | ' : ''}Rescheduled: ${dto.reason}`
          : existing.notes,
        remindersSent: 0,
      },
    });
  }

  async cancel(
    organizationId: string,
    id: string,
    dto: { reason?: string },
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'BOOKED') {
      throw new BadRequestException(
        `Cannot cancel a ${existing.status} appointment`,
      );
    }
    return this.prisma.appointment.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancellationReason: dto.reason ?? 'Cancelled',
      },
    });
  }

  async complete(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'BOOKED') {
      throw new BadRequestException(
        `Cannot complete a ${existing.status} appointment`,
      );
    }
    return this.prisma.appointment.update({
      where: { id },
      data: { status: 'COMPLETED' },
    });
  }

  async markNoShow(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const existing = await this.getOne(organizationId, id, branchScope);
    if (existing.status !== 'BOOKED') {
      throw new BadRequestException(
        `Cannot mark a ${existing.status} appointment as no-show`,
      );
    }
    return this.prisma.appointment.update({
      where: { id },
      data: { status: 'NO_SHOW' },
    });
  }

  // ------------------------------------------------------------------
  // Availability rules / time off
  // ------------------------------------------------------------------

  async listAvailability(organizationId: string, staffId?: string) {
    return this.prisma.trainerAvailabilityRule.findMany({
      where: {
        organizationId,
        ...(staffId ? { staffId } : {}),
      },
      orderBy: [
        { staffId: 'asc' },
        { dayOfWeek: 'asc' },
        { startMinute: 'asc' },
      ],
    });
  }

  async setAvailability(
    organizationId: string,
    dto: {
      staffId: string;
      branchId?: string;
      dayOfWeek: number;
      startMinute: number;
      endMinute: number;
    },
  ) {
    const staff = await this.prisma.staffProfile.findFirst({
      where: { id: dto.staffId, organizationId },
    });
    if (!staff)
      throw new BadRequestException(
        'Staff member not found in this organization',
      );
    if (dto.startMinute >= dto.endMinute) {
      throw new BadRequestException('Availability end must be after start');
    }
    return this.prisma.trainerAvailabilityRule.create({
      data: {
        organizationId,
        staffId: dto.staffId,
        branchId: dto.branchId ?? null,
        dayOfWeek: dto.dayOfWeek,
        startMinute: dto.startMinute,
        endMinute: dto.endMinute,
      },
    });
  }

  async deleteAvailability(organizationId: string, id: string) {
    const rule = await this.prisma.trainerAvailabilityRule.findFirst({
      where: { id, organizationId },
    });
    if (!rule) throw new NotFoundException('Availability rule not found');
    await this.prisma.trainerAvailabilityRule.delete({ where: { id } });
    return { ok: true };
  }

  async listTimeOff(organizationId: string, staffId?: string) {
    return this.prisma.trainerTimeOff.findMany({
      where: {
        organizationId,
        ...(staffId ? { staffId } : {}),
      },
      orderBy: { startAt: 'asc' },
      include: {
        staff: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
  }

  async addTimeOff(
    organizationId: string,
    dto: {
      staffId: string;
      branchId?: string;
      startAt: string;
      endAt: string;
      reason?: string;
    },
  ) {
    const staff = await this.prisma.staffProfile.findFirst({
      where: { id: dto.staffId, organizationId },
    });
    if (!staff)
      throw new BadRequestException(
        'Staff member not found in this organization',
      );
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (startAt >= endAt) {
      throw new BadRequestException('Time-off end must be after start');
    }
    return this.prisma.trainerTimeOff.create({
      data: {
        organizationId,
        staffId: dto.staffId,
        branchId: dto.branchId ?? null,
        startAt,
        endAt,
        reason: dto.reason ?? null,
      },
    });
  }

  async deleteTimeOff(organizationId: string, id: string) {
    const timeOff = await this.prisma.trainerTimeOff.findFirst({
      where: { id, organizationId },
    });
    if (!timeOff) throw new NotFoundException('Time off not found');
    await this.prisma.trainerTimeOff.delete({ where: { id } });
    return { ok: true };
  }

  /// Bookable free slots for a staff member on a given date: subtracts
  /// existing appointments and PT sessions from each availability window.
  async freeSlots(
    organizationId: string,
    staffId: string,
    day: Date,
    branchScope: string | null = null,
  ) {
    const rules = await this.prisma.trainerAvailabilityRule.findMany({
      where: { organizationId, staffId, isActive: true },
    });
    if (rules.length === 0) {
      return { staffId, windows: [], note: 'No availability rules configured' };
    }
    const dayStart = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * MS_PER_MINUTE);
    const [appointments, ptSessions, timeOffs] = await Promise.all([
      this.prisma.appointment.findMany({
        where: {
          organizationId,
          staffId,
          status: 'BOOKED',
          startTime: { lt: dayEnd },
          endTime: { gt: dayStart },
        },
      }),
      this.prisma.ptSession.findMany({
        where: {
          organizationId,
          trainerId: staffId,
          status: 'SCHEDULED',
          startTime: { lt: dayEnd },
          endTime: { gt: dayStart },
        },
      }),
      this.prisma.trainerTimeOff.findMany({
        where: {
          organizationId,
          staffId,
          OR: [
            { branchId: null },
            ...(branchScope ? [{ branchId: branchScope }] : []),
          ],
          startAt: { lt: dayEnd },
          endAt: { gt: dayStart },
        },
      }),
    ]);
    const busy = [...appointments, ...ptSessions].map((x) => ({
      start: x.startTime.getTime(),
      end: x.endTime.getTime(),
    }));
    const blockedByTimeOff = timeOffs.some(
      (t) => t.startAt < dayEnd && t.endAt > dayStart,
    );
    if (blockedByTimeOff) {
      return { staffId, windows: [], note: 'Staff member is on time off' };
    }

    const dow = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    const windows: {
      start: Date;
      end: Date;
      free: { start: Date; end: Date }[];
    }[] = [];
    for (const rule of rules.filter((r) => r.dayOfWeek === dow)) {
      const wStart = new Date(
        dayStart.getTime() + rule.startMinute * MS_PER_MINUTE,
      );
      const wEnd = new Date(
        dayStart.getTime() + rule.endMinute * MS_PER_MINUTE,
      );
      const free: { start: Date; end: Date }[] = [];
      let cursor = wStart.getTime();
      const overlapping = busy
        .filter((b) => b.end > cursor && b.start < wEnd.getTime())
        .sort((a, b) => a.start - b.start);
      for (const b of overlapping) {
        if (b.start > cursor) {
          free.push({
            start: new Date(cursor),
            end: new Date(Math.min(b.start, wEnd.getTime())),
          });
        }
        cursor = Math.max(cursor, b.end);
      }
      if (cursor < wEnd.getTime()) {
        free.push({ start: new Date(cursor), end: wEnd });
      }
      windows.push({ start: wStart, end: wEnd, free });
    }
    return { staffId, windows };
  }
}
