import { Injectable } from '@nestjs/common';
import { organizationTimezone, zonedBound } from '../common/time/zoned';
import { PrismaService } from '../prisma/prisma.service';

export type CapacityBand =
  'UNDERUTILIZED' | 'HEALTHY' | 'HIGH_DEMAND' | 'OVERBOOKED_RISK' | 'UNKNOWN';

export interface ClassCapacitySession {
  sessionId: string;
  programName: string;
  startTime: string;
  capacity: number | null;
  booked: number;
  waitlisted: number;
  utilizationPct: number | null;
  band: CapacityBand;
}

export interface ProgramDemand {
  programId: string;
  programName: string;
  /// Mean booked/capacity over sessions with a known capacity in the
  /// last 56 days, null when there are none — never 0.
  avgUtilizationPct: number | null;
  sessionsCount: number;
}

export interface ClassCapacity {
  upcoming: ClassCapacitySession[];
  demand: ProgramDemand[];
}

export interface SchedulingConflict {
  type: 'INSTRUCTOR_DOUBLE_BOOKING';
  userId: string;
  name: string;
  items: {
    kind: 'CLASS' | 'PT' | 'APPOINTMENT';
    id: string;
    title: string;
    startTime: string;
    endTime: string;
  }[];
}

export type OperationsHealthStatus =
  'healthy' | 'stable' | 'needs-attention' | 'critical' | 'unknown';

export interface OperationsComponent {
  key:
    | 'classes'
    | 'scheduling'
    | 'attendance'
    | 'inventory'
    | 'staff'
    | 'tasks'
    | 'sop'
    | 'equipment'
    | 'facility';
  label: string;
  score: number | null;
  weight: number;
  value: string;
  explanation: string;
  source: string;
}

export interface OperationsHealth {
  score: number | null;
  status: OperationsHealthStatus;
  opportunity: OperationsComponent['key'] | null;
  components: OperationsComponent[];
  staffAway: { name: string; type: string }[];
  branchId: string | null;
  computedAt: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function bandFor(
  utilizationPct: number | null,
  waitlisted: number,
): CapacityBand {
  if (utilizationPct === null) return 'UNKNOWN';
  if (waitlisted > 0 && utilizationPct >= 100) return 'OVERBOOKED_RISK';
  if (utilizationPct >= 90) return 'HIGH_DEMAND';
  if (utilizationPct >= 40) return 'HEALTHY';
  return 'UNDERUTILIZED';
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Operations intelligence from scheduling and attendance rows. No new
 * tables: class capacity from sessions+bookings, conflicts from
 * instructor overlaps across classes/PT/appointments, attendance from
 * the gate log, inventory from the forecast, staff-away from approved
 * leave. Tasks/SOP/equipment/facility/staff-scoring have no models and
 * are reported as unknown with reasons, never invented.
 */
@Injectable()
export class OperationsIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getClassCapacity(
    organizationId: string,
    branchScope: string | null,
  ): Promise<ClassCapacity> {
    const now = new Date();
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [upcoming, history] = await Promise.all([
      this.prisma.classSession.findMany({
        where: {
          ...scoped,
          status: 'ACTIVE',
          startTime: { gte: now, lt: new Date(now.getTime() + 7 * MS_PER_DAY) },
        },
        orderBy: { startTime: 'asc' },
        take: 100,
        include: {
          classProgram: { select: { id: true, name: true, capacity: true } },
          bookings: {
            where: {
              status: { in: ['BOOKED', 'ATTENDED', 'WAITLISTED'] },
            },
            select: { status: true },
          },
        },
      }),
      this.prisma.classSession.findMany({
        where: {
          ...scoped,
          status: 'ACTIVE',
          startTime: {
            gte: new Date(now.getTime() - 56 * MS_PER_DAY),
            lt: now,
          },
        },
        take: 500,
        include: {
          classProgram: { select: { id: true, name: true, capacity: true } },
          bookings: {
            where: { status: { in: ['BOOKED', 'ATTENDED'] } },
            select: { id: true },
          },
        },
      }),
    ]);

    const toEntry = (s: (typeof upcoming)[number]): ClassCapacitySession => {
      const capacity = s.capacity ?? s.classProgram.capacity ?? null;
      const booked = s.bookings.filter((b) => b.status !== 'WAITLISTED').length;
      const waitlisted = s.bookings.length - booked;
      const utilizationPct =
        capacity && capacity > 0 ? Math.round((booked / capacity) * 100) : null;
      return {
        sessionId: s.id,
        programName: s.classProgram.name,
        startTime: s.startTime.toISOString(),
        capacity,
        booked,
        waitlisted,
        utilizationPct,
        band: bandFor(utilizationPct, waitlisted),
      };
    };
    const byProgram = new Map<
      string,
      { name: string; utils: number[]; sessions: number }
    >();
    for (const s of history) {
      const capacity = s.capacity ?? s.classProgram.capacity ?? null;
      const entry = byProgram.get(s.classProgram.id) ?? {
        name: s.classProgram.name,
        utils: [],
        sessions: 0,
      };
      entry.sessions += 1;
      if (capacity && capacity > 0) {
        entry.utils.push(s.bookings.length / capacity);
      }
      byProgram.set(s.classProgram.id, entry);
    }
    return {
      upcoming: upcoming.map(toEntry),
      demand: [...byProgram.entries()].map(([programId, entry]) => ({
        programId,
        programName: entry.name,
        avgUtilizationPct:
          entry.utils.length > 0
            ? Math.round(
                (entry.utils.reduce((a, b) => a + b, 0) / entry.utils.length) *
                  100,
              )
            : null,
        sessionsCount: entry.sessions,
      })),
    };
  }

  async getSchedulingConflicts(
    organizationId: string,
    branchScope: string | null,
  ): Promise<SchedulingConflict[]> {
    const now = new Date();
    const horizon = new Date(now.getTime() + 7 * MS_PER_DAY);
    const scoped = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const [classes, ptSessions, appointments, profiles] = await Promise.all([
      this.prisma.classSession.findMany({
        where: {
          ...scoped,
          status: 'ACTIVE',
          startTime: { gte: now, lt: horizon },
          instructorId: { not: null },
        },
        take: 200,
        include: {
          classProgram: { select: { name: true } },
          instructor: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.ptSession.findMany({
        where: {
          ...scoped,
          status: 'SCHEDULED',
          startTime: { gte: now, lt: horizon },
        },
        take: 200,
        select: { id: true, trainerId: true, startTime: true, endTime: true },
      }),
      this.prisma.appointment.findMany({
        where: {
          ...scoped,
          status: { in: ['BOOKED', 'RESCHEDULED'] },
          startTime: { gte: now, lt: horizon },
          staffId: { not: null },
        },
        take: 200,
        select: {
          id: true,
          staffId: true,
          title: true,
          startTime: true,
          endTime: true,
        },
      }),
      this.prisma.staffProfile.findMany({
        where: { organizationId },
        select: { id: true, userId: true },
      }),
    ]);
    const profileToUser = new Map(profiles.map((p) => [p.id, p.userId]));
    const userNames = new Map<string, string>();
    for (const c of classes) {
      if (c.instructor) {
        userNames.set(
          c.instructor.id,
          `${c.instructor.firstName} ${c.instructor.lastName}`,
        );
      }
    }

    interface Slot {
      kind: 'CLASS' | 'PT' | 'APPOINTMENT';
      id: string;
      title: string;
      start: number;
      end: number;
    }
    const byUser = new Map<string, Slot[]>();
    const push = (userId: string | null, slot: Slot) => {
      if (!userId) return;
      const list = byUser.get(userId) ?? [];
      list.push(slot);
      byUser.set(userId, list);
    };
    for (const c of classes) {
      push(c.instructorId, {
        kind: 'CLASS',
        id: c.id,
        title: c.classProgram.name,
        start: c.startTime.getTime(),
        end: c.endTime.getTime(),
      });
    }
    for (const s of ptSessions) {
      push(s.trainerId ? (profileToUser.get(s.trainerId) ?? null) : null, {
        kind: 'PT',
        id: s.id,
        title: 'PT session',
        start: s.startTime.getTime(),
        end: s.endTime.getTime(),
      });
    }
    for (const a of appointments) {
      push(a.staffId, {
        kind: 'APPOINTMENT',
        id: a.id,
        title: a.title,
        start: a.startTime.getTime(),
        end: a.endTime.getTime(),
      });
    }

    const conflicts: SchedulingConflict[] = [];
    for (const [userId, slots] of byUser) {
      const overlapping = new Map<string, Slot>();
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          if (
            overlaps(slots[i].start, slots[i].end, slots[j].start, slots[j].end)
          ) {
            overlapping.set(slots[i].id, slots[i]);
            overlapping.set(slots[j].id, slots[j]);
          }
        }
      }
      if (overlapping.size >= 2) {
        conflicts.push({
          type: 'INSTRUCTOR_DOUBLE_BOOKING',
          userId,
          name: userNames.get(userId) ?? 'Staff member',
          items: [...overlapping.values()].map((slot) => ({
            kind: slot.kind,
            id: slot.id,
            title: slot.title,
            startTime: new Date(slot.start).toISOString(),
            endTime: new Date(slot.end).toISOString(),
          })),
        });
      }
    }
    return conflicts.slice(0, 20);
  }

  async getOperationsHealth(
    organizationId: string,
    branchScope: string | null,
  ): Promise<OperationsHealth> {
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const now = new Date();
    const [capacity, conflicts, gate, stockList, away] = await Promise.all([
      this.getClassCapacity(organizationId, branchScope),
      this.getSchedulingConflicts(organizationId, branchScope),
      this.gateToday(organizationId, branchScope, timezone, now),
      this.prisma.product.findMany({
        where: {
          organizationId,
          ...(branchScope
            ? { stocks: { some: { branchId: branchScope } } }
            : {}),
        },
        select: { id: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          organizationId,
          status: 'APPROVED',
          startDate: { lte: now },
          endDate: { gte: now },
          ...(branchScope ? { branchId: branchScope } : {}),
        },
        take: 20,
        include: {
          staffProfile: {
            select: { user: { select: { firstName: true, lastName: true } } },
          },
          leaveType: { select: { name: true } },
        },
      }),
    ]);
    const lowStock = await this.lowStockCount(organizationId, branchScope);

    const knownUtils = capacity.upcoming
      .map((s) => s.utilizationPct)
      .filter((u): u is number => u !== null);
    const avgUtil =
      knownUtils.length > 0
        ? Math.round(knownUtils.reduce((a, b) => a + b, 0) / knownUtils.length)
        : null;
    const components: OperationsComponent[] = [
      {
        key: 'classes',
        label: 'Classes',
        score: avgUtil,
        weight: 30,
        value:
          avgUtil === null
            ? 'No bookable sessions ahead'
            : `${avgUtil}% avg fill · ${capacity.upcoming.length} sessions`,
        explanation:
          avgUtil === null
            ? 'No upcoming sessions with a known capacity.'
            : 'Mean booked-over-capacity across the next 7 days.',
        source: 'GET /analytics/classes/capacity',
      },
      {
        key: 'scheduling',
        label: 'Scheduling',
        score: Math.max(0, 100 - conflicts.length * 15),
        weight: 25,
        value:
          conflicts.length === 0
            ? 'No double-bookings'
            : `${conflicts.length} double-booking${conflicts.length === 1 ? '' : 's'}`,
        explanation: 'Instructor overlaps across classes, PT and appointments.',
        source: 'GET /analytics/scheduling/conflicts',
      },
      {
        key: 'attendance',
        label: 'Attendance',
        score:
          gate.total > 0
            ? Math.round((gate.admitted / gate.total) * 100)
            : null,
        weight: 20,
        value: `${gate.admitted} admitted today`,
        explanation:
          gate.total === 0
            ? 'Nobody checked in yet today.'
            : 'Share of gate attempts admitted today.',
        source: 'Attendance gate log',
      },
      {
        key: 'inventory',
        label: 'Inventory',
        score:
          stockList.length > 0
            ? Math.round(
                ((stockList.length - lowStock) / stockList.length) * 100,
              )
            : null,
        weight: 15,
        value: `${lowStock} of ${stockList.length} low`,
        explanation: 'Share of tracked products above reorder level.',
        source: 'Inventory forecast',
      },
      {
        key: 'staff',
        label: 'Staff',
        score: null,
        weight: 10,
        value: `${away.length} away today`,
        explanation:
          'No shift or attendance model exists — away-today is shown, not scored.',
        source: 'Approved leave requests',
      },
      ...(['tasks', 'sop', 'equipment', 'facility'] as const).map(
        (key): OperationsComponent => ({
          key,
          label: key[0].toUpperCase() + key.slice(1),
          score: null,
          weight: 0,
          value: 'No data model',
          explanation: `No ${key} model exists yet — tracked as a gap, not a score.`,
          source: 'Missing capability',
        }),
      ),
    ];
    const available = components.filter(
      (c): c is OperationsComponent & { score: number } => c.score !== null,
    );
    const weightTotal = available.reduce((sum, c) => sum + c.weight, 0);
    const score =
      available.length === 0
        ? null
        : Math.round(
            available.reduce((sum, c) => sum + c.score * c.weight, 0) /
              weightTotal,
          );
    const status: OperationsHealthStatus =
      score === null
        ? 'unknown'
        : score >= 80
          ? 'healthy'
          : score >= 60
            ? 'stable'
            : score >= 40
              ? 'needs-attention'
              : 'critical';
    return {
      score,
      status,
      opportunity:
        available.length === 0
          ? null
          : available.reduce((a, b) => (b.score < a.score ? b : a)).key,
      components,
      staffAway: away.map((r) => ({
        name: r.staffProfile.user
          ? `${r.staffProfile.user.firstName} ${r.staffProfile.user.lastName}`
          : 'Staff member',
        type: r.leaveType.name,
      })),
      branchId: branchScope,
      computedAt: now.toISOString(),
    };
  }

  private async gateToday(
    organizationId: string,
    branchScope: string | null,
    timezone: string,
    now: Date,
  ): Promise<{ admitted: number; total: number }> {
    const start = zonedBound(now.toISOString().slice(0, 10), timezone, 'from');
    const [admitted, total] = await Promise.all([
      this.prisma.attendance.count({
        where: {
          organizationId,
          ...(branchScope ? { branchId: branchScope } : {}),
          deniedReason: null,
          checkInAt: { gte: start },
        },
      }),
      this.prisma.attendance.count({
        where: {
          organizationId,
          ...(branchScope ? { branchId: branchScope } : {}),
          checkInAt: { gte: start },
        },
      }),
    ]);
    return { admitted, total };
  }

  private async lowStockCount(
    organizationId: string,
    branchScope: string | null,
  ): Promise<number> {
    // Mirrors the inventory forecast's own reorder rule (org-wide stock
    // vs per-branch stock) closely enough for a health ratio; the
    // forecast endpoint remains the precise per-product source.
    const products = await this.prisma.product.findMany({
      where: {
        organizationId,
        isActive: true,
        ...(branchScope
          ? { branchStocks: { some: { branchId: branchScope } } }
          : {}),
      },
      select: {
        quantityOnHand: true,
        reorderLevel: true,
        branchStocks: {
          ...(branchScope ? { where: { branchId: branchScope } } : {}),
          select: { quantityOnHand: true },
        },
      },
      take: 2000,
    });
    return products.filter((p) => {
      if (branchScope) {
        const stock = p.branchStocks[0];
        return stock !== undefined && stock.quantityOnHand <= p.reorderLevel;
      }
      return p.quantityOnHand <= p.reorderLevel;
    }).length;
  }
}
