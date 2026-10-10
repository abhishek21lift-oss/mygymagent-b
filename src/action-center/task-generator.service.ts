import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TaskCategory, TaskPriority } from '@prisma/client';
import { FinanceService } from '../analytics/finance.service';
import { validTimezone, zonedDate, zonedMidnight } from '../common/time/zoned';
import { COLLECTED_PAYMENT_STATUSES } from '../memberships/membership-balance';
import { PrismaService } from '../prisma/prisma.service';
import {
  loadSettings,
  type ActionCenterSettings,
} from './action-center.settings';
import { OPEN_STATUSES, fullName } from './action-center.shared';
import { TasksService } from './tasks.service';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface Draft {
  dedupeKey: string;
  title: string;
  description?: string | null;
  category: TaskCategory;
  priority: TaskPriority;
  dueAt: Date;
  branchId: string | null;
  memberId?: string | null;
  leadId?: string | null;
  assignedToUserId?: string | null;
  reason: string;
  sourceType: string;
  sourceId: string;
  escalate?: boolean;
}

interface Day {
  timezone: string;
  now: Date;
  start: Date;
  end: Date;
  /** 10:00 on the gym's day: when generated work is due. */
  due: Date;
  /** Days since the epoch of the gym's calendar date, for cycle keys. */
  number: number;
  label: string;
}

export interface GenerationResult {
  organizationId: string;
  day: string;
  drafted: Record<string, number>;
  created: number;
  resolved: number;
  cancelled: number;
}

const LEAD_DONE = ['WON', 'LOST'] as const;

function ruppees(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

/**
 * Builds each gym's worklist from what is actually in the CRM, and keeps
 * it honest as records change.
 *
 * Idempotent by construction: every generated task carries a dedupe key
 * (`renewal:<membershipId>:<milestone>`, `dues:<membershipId>:<cycle>`,
 * `promise:<promiseId>` ...) under a unique (organizationId, dedupeKey)
 * index, and is inserted with `skipDuplicates`. Running hourly, twice at
 * once, or after a crash adds nothing that is already there. Reconcile
 * then closes open generated tasks whose situation has resolved (renewed,
 * paid, contacted, cancelled) -- it completes or cancels them with the
 * reason, and never deletes one.
 */
@Injectable()
export class TaskGeneratorService {
  private readonly logger = new Logger(TaskGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly tasks: TasksService,
  ) {}

  /** Every active gym. Called hourly by the automation queue. */
  async runAll(
    now = new Date(),
  ): Promise<{ organizations: number; created: number }> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: { in: ['TRIAL', 'ACTIVE'] }, deletedAt: null },
      select: { id: true },
    });
    let created = 0;
    for (const org of orgs) {
      try {
        created += (await this.run(org.id, now)).created;
      } catch (error) {
        this.logger.error(
          `Task generation failed for ${org.id}: ${String(error)}`,
        );
      }
    }
    return { organizations: orgs.length, created };
  }

  async run(
    organizationId: string,
    now = new Date(),
  ): Promise<GenerationResult> {
    const { settings, timezone: tz } = await loadSettings(
      this.prisma,
      organizationId,
    );
    const timezone = validTimezone(tz);
    const { year, month, day: d } = zonedDate(now, timezone);
    const start = zonedMidnight(year, month, d, timezone);
    const day: Day = {
      timezone,
      now,
      start,
      end: zonedMidnight(year, month, d + 1, timezone),
      due: new Date(start.getTime() + 10 * HOUR_MS),
      number: Math.floor(Date.UTC(year, month - 1, d) / DAY_MS),
      label: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    };

    const sources: [string, () => Promise<Draft[]>][] = [
      ['renewals', () => this.renewals(organizationId, day, settings)],
      ['expired', () => this.expired(organizationId, day, settings)],
      ['dues', () => this.dues(organizationId, day, settings)],
      ['promises', () => this.promises(organizationId, day, settings)],
      ['newLeads', () => this.newLeads(organizationId, day, settings)],
      ['trials', () => this.trials(organizationId, day)],
      ['inactive', () => this.inactive(organizationId, day, settings)],
      ['ptConfirmations', () => this.ptConfirmations(organizationId, day)],
      ['complaints', () => this.complaints(organizationId, day)],
      ['memberFollowUps', () => this.memberFollowUps(organizationId, day)],
      ['leadFollowUps', () => this.leadFollowUps(organizationId, day)],
    ];
    const drafted: Record<string, number> = {};
    const all: Draft[] = [];
    for (const [name, build] of sources) {
      const drafts = (await build()).slice(0, settings.maxNewTasksPerSource);
      drafted[name] = drafts.length;
      all.push(...drafts);
    }

    let created = 0;
    if (all.length) {
      const result = await this.prisma.task.createMany({
        data: all.map(({ escalate, ...draft }) => ({
          organizationId,
          ...draft,
          source: 'SYSTEM' as const,
          ...(escalate
            ? { escalatedAt: now, escalationReason: draft.reason }
            : {}),
        })),
        skipDuplicates: true,
      });
      created = result.count;
    }
    await this.notifyBrokenPromises(organizationId, all);
    const superseded = await this.supersede(organizationId, all);
    const { resolved, cancelled } = await this.reconcile(organizationId, day);
    return {
      organizationId,
      day: day.label,
      drafted,
      created,
      resolved,
      cancelled: cancelled + superseded,
    };
  }

  // ---------------------------------------------------------------- sources

  /** Members of `ids` who already have their next term (renewed). */
  private async renewedMemberships(
    organizationId: string,
    memberships: { id: string; memberId: string; endDate: Date }[],
  ): Promise<Set<string>> {
    if (!memberships.length) return new Set();
    const later = await this.prisma.membership.findMany({
      where: {
        organizationId,
        memberId: { in: [...new Set(memberships.map((m) => m.memberId))] },
        status: { in: ['ACTIVE', 'PENDING', 'FROZEN'] },
        id: { notIn: memberships.map((m) => m.id) },
      },
      select: { memberId: true, endDate: true, previousMembershipId: true },
    });
    const renewed = new Set<string>();
    for (const m of memberships) {
      if (
        later.some(
          (l) =>
            l.previousMembershipId === m.id ||
            (l.memberId === m.memberId &&
              l.endDate.getTime() > m.endDate.getTime()),
        )
      ) {
        renewed.add(m.id);
      }
    }
    return renewed;
  }

  private async renewals(
    organizationId: string,
    day: Day,
    settings: ActionCenterSettings,
  ): Promise<Draft[]> {
    const offsets = settings.renewalReminderDays;
    const maxDays = Math.max(...offsets);
    const rows = await this.prisma.membership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        endDate: {
          gte: day.start,
          lt: new Date(day.start.getTime() + (maxDays + 1) * DAY_MS),
        },
        member: { deletedAt: null },
      },
      select: {
        id: true,
        memberId: true,
        endDate: true,
        branchId: true,
        member: { select: { firstName: true, lastName: true } },
        membershipPlan: { select: { name: true } },
      },
      orderBy: { endDate: 'asc' },
      take: 1000,
    });
    const renewed = await this.renewedMemberships(organizationId, rows);
    const drafts: Draft[] = [];
    for (const m of rows) {
      if (renewed.has(m.id)) continue;
      const end = zonedDate(m.endDate, day.timezone);
      const daysLeft = Math.round(
        (zonedMidnight(end.year, end.month, end.day, day.timezone).getTime() -
          day.start.getTime()) /
          DAY_MS,
      );
      // The reminder whose window we are in: 5 days left falls in the
      // 7-day reminder, 2 days left in the 3-day one.
      const milestone = [...offsets]
        .sort((a, b) => a - b)
        .find((o) => o >= daysLeft);
      if (milestone === undefined) continue;
      const name = fullName(m.member) ?? 'Member';
      const endLabel = `${end.day}/${end.month}`;
      drafts.push({
        dedupeKey: `renewal:${m.id}:${milestone}`,
        title:
          daysLeft === 0
            ? `Renewal due today: ${name}`
            : `Renewal: ${name} — ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${endLabel})`,
        description: m.membershipPlan?.name
          ? `Plan: ${m.membershipPlan.name}`
          : null,
        category: 'RENEWAL',
        priority: daysLeft === 0 ? 'URGENT' : daysLeft <= 3 ? 'HIGH' : 'MEDIUM',
        dueAt: day.due,
        branchId: m.branchId,
        memberId: m.memberId,
        reason: `Membership ends on ${endLabel}; this is the ${milestone}-day renewal reminder.`,
        sourceType: 'MEMBERSHIP',
        sourceId: m.id,
      });
    }
    return drafts;
  }

  private async expired(
    organizationId: string,
    day: Day,
    settings: ActionCenterSettings,
  ): Promise<Draft[]> {
    if (settings.expiredLookbackDays === 0) return [];
    const rows = await this.prisma.membership.findMany({
      where: {
        organizationId,
        status: { in: ['ACTIVE', 'EXPIRED'] },
        endDate: {
          gte: new Date(
            day.start.getTime() - settings.expiredLookbackDays * DAY_MS,
          ),
          lt: day.start,
        },
        member: { deletedAt: null },
      },
      select: {
        id: true,
        memberId: true,
        endDate: true,
        branchId: true,
        member: { select: { firstName: true, lastName: true } },
      },
      take: 1000,
    });
    const renewed = await this.renewedMemberships(organizationId, rows);
    return rows
      .filter((m) => !renewed.has(m.id))
      .map((m) => {
        const ago = Math.max(
          1,
          Math.round((day.start.getTime() - m.endDate.getTime()) / DAY_MS),
        );
        const name = fullName(m.member) ?? 'Member';
        return {
          dedupeKey: `expired:${m.id}`,
          title: `Expired, not renewed: ${name} (${ago} day${ago === 1 ? '' : 's'} ago)`,
          category: 'RENEWAL' as const,
          priority: 'HIGH' as const,
          dueAt: day.due,
          branchId: m.branchId,
          memberId: m.memberId,
          reason: 'The membership has ended and no new term has started.',
          sourceType: 'MEMBERSHIP',
          sourceId: m.id,
        };
      });
  }

  private async dues(
    organizationId: string,
    day: Day,
    settings: ActionCenterSettings,
  ): Promise<Draft[]> {
    const rows = await this.finance.listOutstandingMemberships(
      organizationId,
      null,
    );
    if (!rows.length) return [];
    // A member who promised a date is on the promise's track, not this one.
    const promised = await this.prisma.paymentPromise.findMany({
      where: {
        organizationId,
        status: 'OPEN',
        memberId: { in: rows.map((r) => r.member.id) },
      },
      select: { memberId: true },
    });
    const onPromise = new Set(promised.map((p) => p.memberId));
    const cycle = Math.floor(day.number / settings.duesFollowUpIntervalDays);
    return rows
      .filter((r) => Number(r.outstanding) >= 1 && !onPromise.has(r.member.id))
      .map((r) => {
        const ended = r.endDate.getTime() < day.start.getTime();
        const name = fullName(r.member) ?? 'Member';
        return {
          dedupeKey: `dues:${r.membershipId}:${cycle}`,
          title: `Collect ${ruppees(Number(r.outstanding))} due — ${name}`,
          description: r.planName
            ? `Plan: ${r.planName}. Paid ${ruppees(Number(r.paid))} of ${ruppees(Number(r.price))}.`
            : null,
          category: 'PAYMENT_FOLLOW_UP' as const,
          priority: ended ? ('HIGH' as const) : ('MEDIUM' as const),
          dueAt: day.due,
          branchId: r.branch?.id ?? null,
          memberId: r.member.id,
          reason: `${ruppees(Number(r.outstanding))} is outstanding on this membership. Repeats every ${settings.duesFollowUpIntervalDays} days until paid.`,
          sourceType: 'MEMBERSHIP',
          sourceId: r.membershipId,
        };
      });
  }

  /**
   * Payment promises: kept once collected payments since the promise cover
   * it (checked against the payment system, never a note); due on their
   * day; missed after the grace period, which escalates.
   */
  private async promises(
    organizationId: string,
    day: Day,
    settings: ActionCenterSettings,
  ): Promise<Draft[]> {
    const open = await this.prisma.paymentPromise.findMany({
      where: { organizationId, status: 'OPEN', member: { deletedAt: null } },
      select: {
        id: true,
        memberId: true,
        branchId: true,
        amount: true,
        promisedFor: true,
        createdAt: true,
        member: { select: { firstName: true, lastName: true } },
      },
      take: 1000,
    });
    if (!open.length) return [];
    const since = new Date(Math.min(...open.map((p) => p.createdAt.getTime())));
    const payments = await this.prisma.payment.findMany({
      where: {
        organizationId,
        memberId: { in: [...new Set(open.map((p) => p.memberId))] },
        status: { in: [...COLLECTED_PAYMENT_STATUSES] },
        createdAt: { gte: since },
      },
      select: { id: true, memberId: true, amount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const drafts: Draft[] = [];
    for (const p of open) {
      const paid = payments.filter(
        (pay) => pay.memberId === p.memberId && pay.createdAt >= p.createdAt,
      );
      const total = paid.reduce((sum, pay) => sum + Number(pay.amount), 0);
      if (total >= Number(p.amount)) {
        await this.prisma.paymentPromise.updateMany({
          where: { id: p.id, status: 'OPEN' },
          data: {
            status: 'KEPT',
            resolvedAt: day.now,
            resolvedPaymentId: paid[paid.length - 1].id,
          },
        });
        continue;
      }
      const name = fullName(p.member) ?? 'Member';
      const graceEnd =
        p.promisedFor.getTime() + (settings.promiseGraceDays + 1) * DAY_MS;
      if (graceEnd <= day.start.getTime()) {
        await this.prisma.paymentPromise.updateMany({
          where: { id: p.id, status: 'OPEN' },
          data: { status: 'BROKEN', resolvedAt: day.now },
        });
        drafts.push({
          dedupeKey: `promise-broken:${p.id}`,
          title: `Missed payment promise: ${name} (${ruppees(Number(p.amount))})`,
          category: 'PAYMENT_PROMISE',
          priority: 'URGENT',
          dueAt: day.due,
          branchId: p.branchId,
          memberId: p.memberId,
          reason: `Promised ${ruppees(Number(p.amount))} by ${p.promisedFor.toISOString().slice(0, 10)}; ${total ? `only ${ruppees(total)} has come in` : 'nothing has come in'}.`,
          sourceType: 'PAYMENT_PROMISE',
          sourceId: p.id,
          escalate: true,
        });
      } else if (p.promisedFor.getTime() < day.end.getTime()) {
        // Normally created with the promise; this covers one made before
        // that, or whose task was lost.
        drafts.push({
          dedupeKey: `promise:${p.id}`,
          title: `Payment promised: ${ruppees(Number(p.amount))} — ${name}`,
          category: 'PAYMENT_PROMISE',
          priority: 'HIGH',
          dueAt: new Date(p.promisedFor.getTime() + 10 * HOUR_MS),
          branchId: p.branchId,
          memberId: p.memberId,
          reason: 'The member promised this payment for today.',
          sourceType: 'PAYMENT_PROMISE',
          sourceId: p.id,
        });
      }
    }
    return drafts;
  }

  private async newLeads(
    organizationId: string,
    day: Day,
    settings: ActionCenterSettings,
  ): Promise<Draft[]> {
    const rows = await this.prisma.lead.findMany({
      where: {
        organizationId,
        status: 'NEW',
        createdAt: {
          lte: new Date(
            day.now.getTime() - settings.newLeadContactHours * HOUR_MS,
          ),
          gte: new Date(day.now.getTime() - 30 * DAY_MS),
        },
        callLogs: { none: {} },
        // One already on a follow-up schedule gets its task from there.
        followUps: { none: { completedAt: null } },
      },
      select: {
        id: true,
        branchId: true,
        firstName: true,
        lastName: true,
        source: true,
        assignedToUserId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return rows.map((l) => ({
      dedupeKey: `lead-contact:${l.id}`,
      title: `First contact: ${fullName(l)} (new enquiry)`,
      description: l.source ? `Source: ${l.source}` : null,
      category: 'LEAD_FOLLOW_UP' as const,
      priority: 'HIGH' as const,
      dueAt: l.createdAt < day.start ? day.due : day.now,
      branchId: l.branchId,
      leadId: l.id,
      assignedToUserId: l.assignedToUserId,
      reason: `New enquiry with no call logged after ${settings.newLeadContactHours} hours.`,
      sourceType: 'LEAD',
      sourceId: l.id,
    }));
  }

  private async trials(organizationId: string, day: Day): Promise<Draft[]> {
    const select = {
      id: true,
      branchId: true,
      startTime: true,
      status: true,
      clientName: true,
      memberId: true,
      leadId: true,
      member: { select: { firstName: true, lastName: true } },
      lead: {
        select: {
          firstName: true,
          lastName: true,
          status: true,
          assignedToUserId: true,
        },
      },
    } as const;
    const [today, recent] = await Promise.all([
      this.prisma.appointment.findMany({
        where: {
          organizationId,
          type: 'TRIAL',
          status: 'BOOKED',
          startTime: { gte: day.start, lt: day.end },
        },
        select,
        take: 200,
      }),
      this.prisma.appointment.findMany({
        where: {
          organizationId,
          type: 'TRIAL',
          status: { in: ['COMPLETED', 'NO_SHOW'] },
          startTime: {
            gte: new Date(day.start.getTime() - 3 * DAY_MS),
            lt: day.start,
          },
          lead: { status: { notIn: [...LEAD_DONE] } },
        },
        select,
        take: 200,
      }),
    ]);
    const name = (a: (typeof today)[number]) =>
      fullName(a.member ?? a.lead ?? null) ?? a.clientName ?? 'Trial visitor';
    const time = (d: Date) =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: day.timezone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(d);
    return [
      ...today.map((a) => ({
        dedupeKey: `trial-confirm:${a.id}`,
        title: `Confirm today's trial: ${name(a)} at ${time(a.startTime)}`,
        category: 'TRIAL' as const,
        priority: 'HIGH' as const,
        dueAt: new Date(
          Math.max(day.start.getTime(), a.startTime.getTime() - 2 * HOUR_MS),
        ),
        branchId: a.branchId,
        memberId: a.memberId,
        leadId: a.leadId,
        assignedToUserId: a.lead?.assignedToUserId ?? null,
        reason: 'A trial session is booked for today.',
        sourceType: 'APPOINTMENT',
        sourceId: a.id,
      })),
      ...recent.map((a) => ({
        dedupeKey: `trial-followup:${a.id}`,
        title:
          a.status === 'NO_SHOW'
            ? `Missed trial — reschedule: ${name(a)}`
            : `After the trial: ask ${name(a)} to join`,
        category: 'TRIAL' as const,
        priority: 'HIGH' as const,
        dueAt: day.due,
        branchId: a.branchId,
        memberId: a.memberId,
        leadId: a.leadId,
        assignedToUserId: a.lead?.assignedToUserId ?? null,
        reason:
          a.status === 'NO_SHOW'
            ? 'Did not attend the booked trial.'
            : 'Attended a trial and has not joined yet.',
        sourceType: 'APPOINTMENT',
        sourceId: a.id,
      })),
    ];
  }

  private async inactive(
    organizationId: string,
    day: Day,
    settings: ActionCenterSettings,
  ): Promise<Draft[]> {
    const threshold = new Date(
      day.now.getTime() - settings.inactiveDays * DAY_MS,
    );
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: 'ACTIVE',
        joinedAt: { lte: threshold },
        memberships: {
          some: {
            status: 'ACTIVE',
            startDate: { lte: day.now },
            endDate: { gte: day.start },
          },
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryBranchId: true,
      },
      take: 5000,
    });
    if (!members.length) return [];
    const visits = await this.prisma.attendance.groupBy({
      by: ['memberId'],
      where: {
        organizationId,
        memberId: { in: members.map((m) => m.id) },
        deniedReason: null,
      },
      _max: { checkInAt: true },
    });
    const last = new Map(visits.map((v) => [v.memberId, v._max.checkInAt]));
    const cycle = Math.floor(day.number / settings.inactiveDays);
    return members
      .map((m) => ({ m, lastVisit: last.get(m.id) ?? null }))
      .filter(({ lastVisit }) => !lastVisit || lastVisit < threshold)
      .sort(
        (a, b) => (a.lastVisit?.getTime() ?? 0) - (b.lastVisit?.getTime() ?? 0),
      )
      .map(({ m, lastVisit }) => {
        const days = lastVisit
          ? Math.floor((day.now.getTime() - lastVisit.getTime()) / DAY_MS)
          : null;
        return {
          dedupeKey: `inactive:${m.id}:${cycle}`,
          title: days
            ? `Check in with ${fullName(m)} — no visit in ${days} days`
            : `Check in with ${fullName(m)} — no visits recorded`,
          category: 'INACTIVE_MEMBER' as const,
          priority: 'MEDIUM' as const,
          dueAt: day.due,
          branchId: m.primaryBranchId,
          memberId: m.id,
          reason: `Active membership but no check-in for ${settings.inactiveDays}+ days.`,
          sourceType: 'MEMBER',
          sourceId: m.id,
        };
      });
  }

  private async ptConfirmations(
    organizationId: string,
    day: Day,
  ): Promise<Draft[]> {
    const rows = await this.prisma.ptSession.findMany({
      where: {
        organizationId,
        status: 'SCHEDULED',
        startTime: { gte: day.end, lt: new Date(day.end.getTime() + DAY_MS) },
        member: { deletedAt: null },
      },
      select: {
        id: true,
        branchId: true,
        memberId: true,
        startTime: true,
        member: { select: { firstName: true, lastName: true } },
      },
      take: 300,
    });
    const time = (d: Date) =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: day.timezone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(d);
    return rows.map((s) => ({
      dedupeKey: `pt-confirm:${s.id}`,
      title: `Confirm tomorrow's PT session: ${fullName(s.member)} at ${time(s.startTime)}`,
      category: 'PT_CONFIRMATION' as const,
      priority: 'MEDIUM' as const,
      dueAt: day.due,
      branchId: s.branchId,
      memberId: s.memberId,
      reason: 'A personal-training session is scheduled for tomorrow.',
      sourceType: 'PT_SESSION',
      sourceId: s.id,
    }));
  }

  private async complaints(organizationId: string, day: Day): Promise<Draft[]> {
    const rows = await this.prisma.supportTicket.findMany({
      where: {
        organizationId,
        resolvedAt: null,
        status: { notIn: ['RESOLVED', 'CLOSED'] },
        OR: [
          { slaDueAt: { lt: day.end } },
          { priority: { in: ['HIGH', 'URGENT', 'high', 'urgent'] } },
        ],
      },
      select: {
        id: true,
        branchId: true,
        memberId: true,
        subject: true,
        assignedToUserId: true,
        slaDueAt: true,
      },
      take: 200,
    });
    return rows.map((t) => ({
      dedupeKey: `ticket:${t.id}`,
      title: `Unresolved complaint: ${t.subject}`.slice(0, 160),
      category: 'COMPLAINT' as const,
      priority: 'HIGH' as const,
      dueAt: t.slaDueAt && t.slaDueAt < day.end ? t.slaDueAt : day.due,
      branchId: t.branchId,
      memberId: t.memberId,
      assignedToUserId: t.assignedToUserId,
      reason: t.slaDueAt
        ? 'Open support ticket at or past its response deadline.'
        : 'High-priority support ticket still open.',
      sourceType: 'SUPPORT_TICKET',
      sourceId: t.id,
    }));
  }

  private async memberFollowUps(
    organizationId: string,
    day: Day,
  ): Promise<Draft[]> {
    const rows = await this.prisma.memberFollowUp.findMany({
      where: {
        organizationId,
        completedAt: null,
        dueAt: {
          lt: day.end,
          gte: new Date(day.start.getTime() - 60 * DAY_MS),
        },
        member: { deletedAt: null },
      },
      select: {
        id: true,
        title: true,
        description: true,
        dueAt: true,
        priority: true,
        assignedToUserId: true,
        memberId: true,
        member: {
          select: { firstName: true, lastName: true, primaryBranchId: true },
        },
      },
      take: 1000,
    });
    const priority = (p: string): TaskPriority =>
      (['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const).includes(p as TaskPriority)
        ? (p as TaskPriority)
        : 'MEDIUM';
    return rows.map((f) => ({
      dedupeKey: `member-follow-up:${f.id}`,
      title: `${f.title} — ${fullName(f.member)}`.slice(0, 160),
      description: f.description,
      category: 'FOLLOW_UP' as const,
      priority: priority(f.priority),
      dueAt: f.dueAt!,
      branchId: f.member.primaryBranchId,
      memberId: f.memberId,
      assignedToUserId: f.assignedToUserId,
      reason: 'A follow-up scheduled on the member profile is due.',
      sourceType: 'MEMBER_FOLLOW_UP',
      sourceId: f.id,
    }));
  }

  private async leadFollowUps(
    organizationId: string,
    day: Day,
  ): Promise<Draft[]> {
    const rows = await this.prisma.leadFollowUp.findMany({
      where: {
        organizationId,
        completedAt: null,
        dueAt: {
          lt: day.end,
          gte: new Date(day.start.getTime() - 60 * DAY_MS),
        },
        lead: { status: { notIn: [...LEAD_DONE] } },
      },
      select: {
        id: true,
        dueAt: true,
        note: true,
        leadId: true,
        lead: {
          select: {
            firstName: true,
            lastName: true,
            branchId: true,
            assignedToUserId: true,
          },
        },
      },
      take: 1000,
    });
    return rows.map((f) => ({
      dedupeKey: `lead-follow-up:${f.id}`,
      title: `Follow up: ${fullName(f.lead)}`,
      description:
        f.note === 'auto-first-touch'
          ? 'First contact with a new enquiry.'
          : f.note,
      category: 'LEAD_FOLLOW_UP' as const,
      priority: 'HIGH' as const,
      dueAt: f.dueAt,
      branchId: f.lead.branchId,
      leadId: f.leadId,
      assignedToUserId: f.lead.assignedToUserId,
      reason: 'A lead follow-up is due.',
      sourceType: 'LEAD_FOLLOW_UP',
      sourceId: f.id,
    }));
  }

  // ------------------------------------------------------- after inserting

  private async notifyBrokenPromises(
    organizationId: string,
    drafts: Draft[],
  ): Promise<void> {
    const broken = drafts.filter((d) =>
      d.dedupeKey.startsWith('promise-broken:'),
    );
    for (const d of broken) {
      const task = await this.prisma.task.findUnique({
        where: {
          organizationId_dedupeKey: { organizationId, dedupeKey: d.dedupeKey },
        },
        select: { id: true },
      });
      if (!task) continue;
      // The notification's own dedupe key makes this once per promise.
      await this.tasks.notifyManagers(organizationId, d.branchId, {
        type: 'PAYMENT_PROMISE_MISSED',
        title: d.title,
        body: d.reason,
        taskId: task.id,
        dedupeKey: d.dedupeKey,
      });
    }
  }

  /**
   * A later renewal reminder replaces an earlier one still open, and a new
   * dues cycle replaces the last: one live task per situation.
   */
  private async supersede(
    organizationId: string,
    drafts: Draft[],
  ): Promise<number> {
    let count = 0;
    for (const d of drafts) {
      const family =
        d.dedupeKey.startsWith('renewal:') || d.dedupeKey.startsWith('expired:')
          ? ['renewal:']
          : d.dedupeKey.startsWith('dues:')
            ? ['dues:']
            : d.dedupeKey.startsWith('promise-broken:')
              ? ['promise:']
              : null;
      if (!family) continue;
      const stale = await this.prisma.task.findMany({
        where: {
          organizationId,
          sourceId: d.sourceId,
          status: { in: OPEN_STATUSES },
          dedupeKey: { startsWith: family[0], not: d.dedupeKey },
        },
        select: { id: true },
      });
      if (!stale.length) continue;
      count += await this.close(
        organizationId,
        stale.map((s) => s.id),
        'CANCELLED',
        'Replaced by a newer reminder.',
        'SUPERSEDED',
      );
    }
    return count;
  }

  /** Close open generated tasks whose situation has resolved. */
  private async reconcile(
    organizationId: string,
    day: Day,
  ): Promise<{ resolved: number; cancelled: number }> {
    const open = await this.prisma.task.findMany({
      where: {
        organizationId,
        status: { in: OPEN_STATUSES },
        dedupeKey: { not: null },
        sourceId: { not: null },
      },
      select: {
        id: true,
        dedupeKey: true,
        sourceType: true,
        sourceId: true,
        createdAt: true,
        memberId: true,
        member: { select: { deletedAt: true } },
      },
      take: 5000,
    });
    const resolve: Map<string, string[]> = new Map();
    const cancel: Map<string, string[]> = new Map();
    const add = (map: Map<string, string[]>, reason: string, id: string) =>
      map.set(reason, [...(map.get(reason) ?? []), id]);
    const ids = (type: string, prefix?: string) =>
      open.filter(
        (t) =>
          t.sourceType === type && (!prefix || t.dedupeKey!.startsWith(prefix)),
      );

    for (const t of open) {
      if (t.member?.deletedAt) add(cancel, 'The member was removed.', t.id);
    }

    // Memberships: renewed or cancelled ends renewal/expiry calls; a
    // cleared balance ends the dues call.
    const membershipTasks = ids('MEMBERSHIP');
    if (membershipTasks.length) {
      const memberships = await this.prisma.membership.findMany({
        where: {
          organizationId,
          id: { in: [...new Set(membershipTasks.map((t) => t.sourceId!))] },
        },
        select: { id: true, memberId: true, endDate: true, status: true },
      });
      const byId = new Map(memberships.map((m) => [m.id, m]));
      const renewed = await this.renewedMemberships(
        organizationId,
        memberships,
      );
      const duesTasks = membershipTasks.filter((t) =>
        t.dedupeKey!.startsWith('dues:'),
      );
      const outstanding = duesTasks.length
        ? new Set(
            (
              await this.finance.listOutstandingMemberships(
                organizationId,
                null,
              )
            ).map((r) => r.membershipId),
          )
        : new Set<string>();
      for (const t of membershipTasks) {
        const m = byId.get(t.sourceId!);
        if (!m) {
          add(cancel, 'The membership no longer exists.', t.id);
          continue;
        }
        if (t.dedupeKey!.startsWith('dues:')) {
          if (!outstanding.has(m.id))
            add(resolve, 'The balance has been cleared.', t.id);
        } else if (renewed.has(m.id)) {
          add(resolve, 'The member renewed.', t.id);
        } else if (m.status === 'CANCELLED') {
          add(cancel, 'The membership was cancelled.', t.id);
        }
      }
    }

    const promiseTasks = ids('PAYMENT_PROMISE');
    if (promiseTasks.length) {
      const promises = await this.prisma.paymentPromise.findMany({
        where: {
          organizationId,
          id: { in: [...new Set(promiseTasks.map((t) => t.sourceId!))] },
        },
        select: { id: true, status: true },
      });
      const status = new Map(promises.map((p) => [p.id, p.status]));
      for (const t of promiseTasks) {
        const s = status.get(t.sourceId!);
        if (s === 'KEPT')
          add(resolve, 'Payment received: the promise was kept.', t.id);
        else if (s === 'CANCELLED')
          add(cancel, 'The promise was withdrawn.', t.id);
      }
    }

    const leadTasks = ids('LEAD');
    if (leadTasks.length) {
      const leads = await this.prisma.lead.findMany({
        where: {
          organizationId,
          id: { in: leadTasks.map((t) => t.sourceId!) },
        },
        select: {
          id: true,
          status: true,
          _count: { select: { callLogs: true } },
        },
      });
      const byId = new Map(leads.map((l) => [l.id, l]));
      for (const t of leadTasks) {
        const l = byId.get(t.sourceId!);
        if (!l) add(cancel, 'The lead was removed.', t.id);
        else if (l.status !== 'NEW' || l._count.callLogs > 0)
          add(resolve, 'The lead has been contacted.', t.id);
      }
    }

    const apptTasks = ids('APPOINTMENT');
    if (apptTasks.length) {
      const appts = await this.prisma.appointment.findMany({
        where: {
          organizationId,
          id: { in: apptTasks.map((t) => t.sourceId!) },
        },
        select: { id: true, status: true, lead: { select: { status: true } } },
      });
      const byId = new Map(appts.map((a) => [a.id, a]));
      for (const t of apptTasks) {
        const a = byId.get(t.sourceId!);
        if (!a || a.status === 'CANCELLED')
          add(cancel, 'The trial was cancelled.', t.id);
        else if (
          t.dedupeKey!.startsWith('trial-followup:') &&
          a.lead &&
          LEAD_DONE.includes(a.lead.status as (typeof LEAD_DONE)[number])
        ) {
          add(
            resolve,
            a.lead.status === 'WON'
              ? 'The lead joined.'
              : 'The lead was closed as lost.',
            t.id,
          );
        }
      }
    }

    const ptTasks = ids('PT_SESSION');
    if (ptTasks.length) {
      const sessions = await this.prisma.ptSession.findMany({
        where: { organizationId, id: { in: ptTasks.map((t) => t.sourceId!) } },
        select: { id: true, status: true },
      });
      const byId = new Map(sessions.map((s) => [s.id, s.status]));
      for (const t of ptTasks) {
        const s = byId.get(t.sourceId!);
        if (!s || s === 'CANCELLED')
          add(cancel, 'The PT session was cancelled.', t.id);
        else if (s !== 'SCHEDULED')
          add(resolve, 'The PT session has happened.', t.id);
      }
    }

    const ticketTasks = ids('SUPPORT_TICKET');
    if (ticketTasks.length) {
      const tickets = await this.prisma.supportTicket.findMany({
        where: {
          organizationId,
          id: { in: ticketTasks.map((t) => t.sourceId!) },
        },
        select: { id: true, resolvedAt: true, status: true },
      });
      const byId = new Map(tickets.map((x) => [x.id, x]));
      for (const t of ticketTasks) {
        const x = byId.get(t.sourceId!);
        if (!x) add(cancel, 'The ticket was removed.', t.id);
        else if (x.resolvedAt || ['RESOLVED', 'CLOSED'].includes(x.status))
          add(resolve, 'The ticket was resolved.', t.id);
      }
    }

    for (const [type, model] of [
      ['MEMBER_FOLLOW_UP', 'memberFollowUp'],
      ['LEAD_FOLLOW_UP', 'leadFollowUp'],
    ] as const) {
      const list = ids(type);
      if (!list.length) continue;
      const rows: { id: string; completedAt: Date | null }[] =
        model === 'memberFollowUp'
          ? await this.prisma.memberFollowUp.findMany({
              where: {
                organizationId,
                id: { in: list.map((t) => t.sourceId!) },
              },
              select: { id: true, completedAt: true },
            })
          : await this.prisma.leadFollowUp.findMany({
              where: {
                organizationId,
                id: { in: list.map((t) => t.sourceId!) },
              },
              select: { id: true, completedAt: true },
            });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const t of list) {
        const r = byId.get(t.sourceId!);
        if (!r) add(cancel, 'The follow-up was deleted.', t.id);
        else if (r.completedAt)
          add(resolve, 'The follow-up was completed.', t.id);
      }
    }

    const inactiveTasks = ids('MEMBER', 'inactive:');
    if (inactiveTasks.length) {
      const visits = await this.prisma.attendance.groupBy({
        by: ['memberId'],
        where: {
          organizationId,
          memberId: { in: inactiveTasks.map((t) => t.sourceId!) },
          deniedReason: null,
        },
        _max: { checkInAt: true },
      });
      const last = new Map(visits.map((v) => [v.memberId, v._max.checkInAt]));
      for (const t of inactiveTasks) {
        const visit = last.get(t.sourceId!);
        if (visit && visit > t.createdAt)
          add(resolve, 'The member has visited again.', t.id);
      }
    }

    let resolved = 0;
    let cancelled = 0;
    const done = new Set<string>();
    for (const [reason, list] of cancel) {
      const fresh = list.filter((id) => !done.has(id));
      fresh.forEach((id) => done.add(id));
      cancelled += await this.close(
        organizationId,
        fresh,
        'CANCELLED',
        reason,
        'AUTO_RESOLVED',
      );
    }
    for (const [reason, list] of resolve) {
      const fresh = list.filter((id) => !done.has(id));
      fresh.forEach((id) => done.add(id));
      resolved += await this.close(
        organizationId,
        fresh,
        'COMPLETED',
        reason,
        'AUTO_RESOLVED',
      );
    }
    void day;
    return { resolved, cancelled };
  }

  private async close(
    organizationId: string,
    taskIds: string[],
    status: 'COMPLETED' | 'CANCELLED',
    reason: string,
    eventType: string,
  ): Promise<number> {
    if (!taskIds.length) return 0;
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Only rows still open: a person who closed it meanwhile wins.
      const open = await tx.task.findMany({
        where: {
          id: { in: taskIds },
          organizationId,
          status: { in: OPEN_STATUSES },
        },
        select: { id: true },
      });
      if (!open.length) return 0;
      const ids = open.map((t) => t.id);
      await tx.task.updateMany({
        where: { id: { in: ids }, status: { in: OPEN_STATUSES } },
        data:
          status === 'COMPLETED'
            ? {
                status,
                completedAt: now,
                completionNote: `Resolved automatically: ${reason}`,
              }
            : { status, cancelledAt: now, cancelReason: reason },
      });
      await tx.taskEvent.createMany({
        data: ids.map((taskId) => ({
          organizationId,
          taskId,
          actorUserId: null,
          type: eventType,
          body: reason,
          data: { to: status } as Prisma.InputJsonValue,
        })),
      });
      return ids.length;
    });
  }
}
