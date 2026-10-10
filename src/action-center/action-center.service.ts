import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TaskCategory } from '@prisma/client';
import { validTimezone } from '../common/time/zoned';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { membershipBalances } from '../memberships/membership-balance';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  inQuietHours,
  loadSettings,
  normaliseSettings,
  type ActionCenterSettings,
} from './action-center.settings';
import {
  OPEN_STATUSES,
  PERSON_SELECT,
  TASK_LIST_SELECT,
  fullName,
  gymDay,
  managerUserIds,
  money,
  taskScope,
} from './action-center.shared';
import type { DayQueryDto } from './dto/action-center.dto';

const DAY_MS = 86_400_000;
const CALL_CATEGORIES: TaskCategory[] = ['CALL', 'FOLLOW_UP', 'LEAD_FOLLOW_UP'];
const PAYMENT_CATEGORIES: TaskCategory[] = [
  'PAYMENT_FOLLOW_UP',
  'PAYMENT_PROMISE',
];

/**
 * The read side of the Action Center -- today's numbers, the call queue,
 * the briefing and the end-of-day report -- plus the reminder sweep. Every
 * figure is a count over real rows in the caller's tenant and branch.
 */
@Injectable()
export class ActionCenterService {
  private readonly logger = new Logger(ActionCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private where(
    user: AuthenticatedUser,
    branchScope: string | null,
    q: DayQueryDto,
  ): Prisma.TaskWhereInput {
    return {
      ...taskScope(user.organizationId!, branchScope ?? q.branchId ?? null),
      ...(q.assignedToUserId ? { assignedToUserId: q.assignedToUserId } : {}),
    };
  }

  async summary(
    user: AuthenticatedUser,
    branchScope: string | null,
    q: DayQueryDto,
  ) {
    const organizationId = user.organizationId!;
    const day = await gymDay(this.prisma, organizationId, q.date);
    const base = this.where(user, branchScope, q);
    const dueToday = { dueAt: { gte: day.start, lt: day.end } };
    const openByEnd = {
      ...base,
      status: { in: OPEN_STATUSES },
      dueAt: { lt: day.end },
    };
    const branch = branchScope ?? q.branchId ?? null;
    const callWhere: Prisma.CallLogWhereInput = {
      organizationId,
      ...(branch ? { branchId: branch } : {}),
      calledAt: { gte: day.start, lt: day.end },
    };

    const [
      todayByStatus,
      overdue,
      highPriority,
      openByCategory,
      completedToday,
      byStaff,
      callsToday,
      pendingProposals,
      promisesDue,
      escalated,
      unassigned,
    ] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { ...base, ...dueToday },
        _count: true,
      }),
      this.prisma.task.count({
        where: {
          ...base,
          status: { in: OPEN_STATUSES },
          dueAt: { lt: day.start },
        },
      }),
      this.prisma.task.count({
        where: { ...openByEnd, priority: { in: ['HIGH', 'URGENT'] } },
      }),
      this.prisma.task.groupBy({
        by: ['category'],
        where: openByEnd,
        _count: true,
      }),
      this.prisma.task.count({
        where: {
          ...base,
          status: 'COMPLETED',
          completedAt: { gte: day.start, lt: day.end },
        },
      }),
      this.prisma.task.groupBy({
        by: ['completedByUserId'],
        where: {
          ...base,
          status: 'COMPLETED',
          completedAt: { gte: day.start, lt: day.end },
          completedByUserId: { not: null },
        },
        _count: true,
      }),
      this.prisma.callLog.count({ where: callWhere }),
      this.prisma.actionProposal.count({
        where: {
          organizationId,
          status: 'PENDING',
          ...(branch ? { callLog: { branchId: branch } } : {}),
        },
      }),
      this.prisma.paymentPromise.count({
        where: {
          organizationId,
          status: 'OPEN',
          promisedFor: { lt: day.end },
          ...(branch ? { branchId: branch } : {}),
        },
      }),
      this.prisma.task.count({
        where: {
          ...base,
          status: { in: OPEN_STATUSES },
          escalatedAt: { not: null },
        },
      }),
      this.prisma.task.count({
        where: { ...openByEnd, assignedToUserId: null },
      }),
    ]);

    const statusCount = (s: string) =>
      todayByStatus.find((r) => r.status === s)?._count ?? 0;
    const totalToday = todayByStatus
      .filter((r) => r.status !== 'CANCELLED')
      .reduce((sum, r) => sum + r._count, 0);
    const doneToday = statusCount('COMPLETED');
    const category = (cats: TaskCategory[]) =>
      openByCategory
        .filter((r) => cats.includes(r.category))
        .reduce((s, r) => s + r._count, 0);

    const staffIds = byStaff.map((r) => r.completedByUserId!).filter(Boolean);
    const staff = staffIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: staffIds }, organizationId },
          select: PERSON_SELECT,
        })
      : [];
    const names = new Map(staff.map((s) => [s.id, fullName(s)]));

    return {
      date: day.key,
      timezone: day.timezone,
      tasks: {
        total: totalToday,
        completed: doneToday,
        pending:
          statusCount('PENDING') +
          statusCount('IN_PROGRESS') +
          statusCount('BLOCKED'),
        completionPct: totalToday
          ? Math.round((doneToday / totalToday) * 100)
          : null,
        completedAnyDueToday: completedToday,
        overdue,
        highPriority,
        unassigned,
        escalated,
      },
      due: {
        calls: category(CALL_CATEGORIES),
        payments: category(PAYMENT_CATEGORIES),
        renewals: category(['RENEWAL']),
        newLeads: category(['LEAD_FOLLOW_UP']),
        followUps: category(['FOLLOW_UP']),
        trials: category(['TRIAL']),
        complaints: category(['COMPLAINT']),
        inactive: category(['INACTIVE_MEMBER']),
        ptConfirmations: category(['PT_CONFIRMATION']),
      },
      callsLogged: callsToday,
      pendingSuggestions: pendingProposals,
      promisesDue,
      completedByStaff: byStaff
        .map((r) => ({
          userId: r.completedByUserId!,
          name: names.get(r.completedByUserId!) ?? 'Former staff',
          completed: r._count,
        }))
        .sort((a, b) => b.completed - a.completed),
    };
  }

  /**
   * The follow-up queue: today's open member/lead tasks, highest priority
   * first, each with what a caller needs on screen -- last call, balance,
   * membership state -- and the plain reasons it is in the queue.
   */
  async queue(
    user: AuthenticatedUser,
    branchScope: string | null,
    q: DayQueryDto,
  ) {
    const organizationId = user.organizationId!;
    const day = await gymDay(this.prisma, organizationId, q.date);
    const tasks = await this.prisma.task.findMany({
      where: {
        ...this.where(user, branchScope, q),
        status: { in: OPEN_STATUSES },
        dueAt: { lt: day.end },
        OR: [{ memberId: { not: null } }, { leadId: { not: null } }],
      },
      select: TASK_LIST_SELECT,
      orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
      take: 60,
    });
    const memberIds = [
      ...new Set(tasks.map((t) => t.member?.id).filter(Boolean)),
    ] as string[];
    const leadIds = [
      ...new Set(tasks.map((t) => t.lead?.id).filter(Boolean)),
    ] as string[];
    const since = new Date(day.start.getTime() - 14 * DAY_MS);

    const [calls, memberships, payments] = await Promise.all([
      this.prisma.callLog.findMany({
        where: {
          organizationId,
          OR: [{ memberId: { in: memberIds } }, { leadId: { in: leadIds } }],
        },
        select: {
          memberId: true,
          leadId: true,
          calledAt: true,
          outcome: true,
          response: true,
        },
        orderBy: { calledAt: 'desc' },
        take: 600,
      }),
      // An empty `in` matches nothing: no members, no queries' worth of rows.
      this.prisma.membership.findMany({
        where: { organizationId, memberId: { in: memberIds } },
        select: {
          id: true,
          memberId: true,
          status: true,
          endDate: true,
          price: true,
          membershipPlan: { select: { name: true } },
        },
        orderBy: { endDate: 'desc' },
      }),
      this.prisma.payment.findMany({
        where: {
          organizationId,
          memberId: { in: memberIds },
          membershipId: { not: null },
        },
        select: {
          membershipId: true,
          amount: true,
          status: true,
          refunds: { select: { amount: true } },
        },
      }),
    ]);

    return tasks.map((t) => {
      const subjectCalls = calls.filter((c) =>
        t.member ? c.memberId === t.member.id : c.leadId === t.lead?.id,
      );
      const failed = subjectCalls.filter(
        (c) => c.calledAt >= since && ['NO_ANSWER', 'BUSY'].includes(c.outcome),
      ).length;
      const own = t.member
        ? memberships.filter((m) => m.memberId === t.member!.id)
        : [];
      const balances = own.length
        ? membershipBalances(
            own,
            payments.filter((p) => own.some((m) => m.id === p.membershipId)),
          ).total.outstanding
        : null;
      const current = own[0] ?? null;
      const reasons: string[] = [];
      if (t.reason) reasons.push(t.reason);
      if (failed >= 2)
        reasons.push(`${failed} unanswered calls in the last 14 days.`);
      if (balances && Number(balances) > 0)
        reasons.push(
          `₹${Number(balances).toLocaleString('en-IN')} outstanding.`,
        );
      if (
        current &&
        current.endDate < new Date(day.start.getTime() + 7 * DAY_MS) &&
        current.endDate >= day.start
      ) {
        reasons.push('Membership ends within a week.');
      }
      return {
        task: { ...t, isOverdue: t.dueAt < day.start },
        lastCall: subjectCalls[0] ?? null,
        unansweredCalls14d: failed,
        outstanding: balances ? money(balances) : null,
        membership: current
          ? {
              status: current.status,
              endDate: current.endDate,
              plan: current.membershipPlan?.name ?? null,
            }
          : null,
        reasons: [...new Set(reasons)],
      };
    });
  }

  /** End of day: what got done, what moved, what is still open. */
  async report(
    user: AuthenticatedUser,
    branchScope: string | null,
    q: DayQueryDto,
  ) {
    const organizationId = user.organizationId!;
    const day = await gymDay(this.prisma, organizationId, q.date);
    const base = this.where(user, branchScope, q);
    const branch = branchScope ?? q.branchId ?? null;
    const inDay = { gte: day.start, lt: day.end };
    const branchCall = branch ? { branchId: branch } : {};

    const [
      completed,
      completedCount,
      callsByOutcome,
      followUpsScheduled,
      promisesKept,
      paymentsToday,
      leadsConverted,
      leadCalls,
      unresolved,
      unresolvedCount,
    ] = await Promise.all([
      this.prisma.task.findMany({
        where: { ...base, status: 'COMPLETED', completedAt: inDay },
        select: {
          id: true,
          title: true,
          category: true,
          completedAt: true,
          completionNote: true,
          completedByUserId: true,
        },
        orderBy: { completedAt: 'desc' },
        take: 50,
      }),
      this.prisma.task.count({
        where: { ...base, status: 'COMPLETED', completedAt: inDay },
      }),
      this.prisma.callLog.groupBy({
        by: ['outcome'],
        where: { organizationId, ...branchCall, calledAt: inDay },
        _count: true,
      }),
      this.prisma.task.count({
        where: {
          ...base,
          createdAt: inDay,
          dueAt: { gte: day.end },
          status: { in: OPEN_STATUSES },
        },
      }),
      this.prisma.paymentPromise.count({
        where: {
          organizationId,
          ...branchCall,
          status: 'KEPT',
          resolvedAt: inDay,
        },
      }),
      this.prisma.payment.aggregate({
        where: {
          organizationId,
          ...branchCall,
          status: 'COMPLETED',
          createdAt: inDay,
        },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.lead.count({
        where: {
          organizationId,
          ...(branch ? { branchId: branch } : {}),
          convertedAt: inDay,
        },
      }),
      this.prisma.callLog.count({
        where: {
          organizationId,
          ...branchCall,
          calledAt: inDay,
          leadId: { not: null },
        },
      }),
      this.prisma.task.findMany({
        where: {
          ...base,
          status: { in: OPEN_STATUSES },
          dueAt: { lt: day.end },
        },
        select: {
          id: true,
          title: true,
          priority: true,
          dueAt: true,
          category: true,
        },
        orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
        take: 50,
      }),
      this.prisma.task.count({
        where: {
          ...base,
          status: { in: OPEN_STATUSES },
          dueAt: { lt: day.end },
        },
      }),
    ]);

    return {
      date: day.key,
      completed: { count: completedCount, items: completed },
      calls: {
        total: callsByOutcome.reduce((s, r) => s + r._count, 0),
        byOutcome: Object.fromEntries(
          callsByOutcome.map((r) => [r.outcome, r._count]),
        ),
      },
      followUpsScheduled,
      payments: {
        promisesKept,
        verifiedPayments: paymentsToday._count,
        verifiedAmount: money(paymentsToday._sum.amount ?? 0),
      },
      leads: { called: leadCalls, converted: leadsConverted },
      unresolved: { count: unresolvedCount, items: unresolved },
    };
  }

  /**
   * The morning briefing: the day's priorities in a few lines, each linked
   * to the records behind it. Built from counts and rows, not generated
   * prose, so every line is true.
   */
  async briefing(
    user: AuthenticatedUser,
    branchScope: string | null,
    q: DayQueryDto,
  ) {
    const s = await this.summary(user, branchScope, q);
    const organizationId = user.organizationId!;
    const day = await gymDay(this.prisma, organizationId, q.date);
    const urgent = await this.prisma.task.findMany({
      where: {
        ...this.where(user, branchScope, q),
        status: { in: OPEN_STATUSES },
        dueAt: { lt: day.end },
        priority: 'URGENT',
      },
      select: { id: true, title: true },
      orderBy: { dueAt: 'asc' },
      take: 5,
    });
    const lines: {
      text: string;
      href: string;
      tone: 'urgent' | 'warn' | 'info';
    }[] = [];
    const plural = (n: number, one: string, many = `${one}s`) =>
      `${n} ${n === 1 ? one : many}`;
    for (const t of urgent)
      lines.push({
        text: t.title,
        href: `/action-center?task=${t.id}`,
        tone: 'urgent',
      });
    if (s.tasks.overdue)
      lines.push({
        text: `${plural(s.tasks.overdue, 'task')} overdue from earlier days`,
        href: '/action-center?view=overdue',
        tone: 'warn',
      });
    if (s.promisesDue)
      lines.push({
        text: `${plural(s.promisesDue, 'payment promise')} due by today`,
        href: '/action-center?category=PAYMENT_PROMISE',
        tone: 'warn',
      });
    if (s.due.payments)
      lines.push({
        text: `${plural(s.due.payments, 'payment follow-up')} to make`,
        href: '/action-center?category=PAYMENT_FOLLOW_UP',
        tone: 'info',
      });
    if (s.due.renewals)
      lines.push({
        text: `${plural(s.due.renewals, 'renewal call')} (memberships ending soon or just expired)`,
        href: '/action-center?category=RENEWAL',
        tone: 'info',
      });
    if (s.due.newLeads)
      lines.push({
        text: `${plural(s.due.newLeads, 'lead')} waiting for contact`,
        href: '/action-center?category=LEAD_FOLLOW_UP',
        tone: 'info',
      });
    if (s.tasks.escalated)
      lines.push({
        text: `${plural(s.tasks.escalated, 'escalation')} waiting for a manager`,
        href: '/action-center?view=escalated',
        tone: 'urgent',
      });
    if (s.pendingSuggestions)
      lines.push({
        text: `${plural(s.pendingSuggestions, 'AI suggestion')} to review`,
        href: '/action-center?view=suggestions',
        tone: 'info',
      });
    if (s.tasks.unassigned)
      lines.push({
        text: `${plural(s.tasks.unassigned, 'task')} not assigned to anyone`,
        href: '/action-center?view=unassigned',
        tone: 'info',
      });
    return {
      date: s.date,
      headline: s.tasks.total
        ? `${s.tasks.pending} of ${s.tasks.total} tasks still open today${s.tasks.overdue ? `, plus ${s.tasks.overdue} overdue` : ''}.`
        : s.tasks.overdue
          ? `Nothing new today, but ${s.tasks.overdue} overdue.`
          : 'Nothing on the list for today.',
      lines,
    };
  }

  /**
   * Who a task can be assigned to: active staff of this gym, names only.
   * Its own endpoint so the front desk can pick a colleague without the
   * user-management permission that the full /users list needs.
   */
  async staff(organizationId: string) {
    const users = await this.prisma.user.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        member: null,
        userRoles: {
          some: { organizationId, role: { key: { not: 'MEMBER' } } },
        },
      },
      select: PERSON_SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 200,
    });
    return users.map((u) => ({ id: u.id, name: fullName(u) }));
  }

  async getSettings(organizationId: string): Promise<ActionCenterSettings> {
    return (await loadSettings(this.prisma, organizationId)).settings;
  }

  async updateSettings(
    organizationId: string,
    patch: Partial<ActionCenterSettings>,
  ) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = (org.settings as Record<string, unknown> | null) ?? {};
    const current = normaliseSettings(settings.actionCenter);
    const next = normaliseSettings({ ...current, ...patch });
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        settings: {
          ...settings,
          actionCenter: next,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return next;
  }

  /**
   * Every 15 minutes: remind assignees of tasks coming due, and tell
   * managers about HIGH/URGENT tasks long overdue. Notification dedupe keys
   * make each reminder once; quiet hours just postpone it.
   */
  async sweepReminders(
    now = new Date(),
  ): Promise<{ reminded: number; escalated: number }> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: { in: ['TRIAL', 'ACTIVE'] }, deletedAt: null },
      select: { id: true },
    });
    let reminded = 0;
    let escalated = 0;
    for (const org of orgs) {
      try {
        const { settings, timezone } = await loadSettings(this.prisma, org.id);
        const tz = validTimezone(timezone);
        const hour = Number(
          new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            hourCycle: 'h23',
          }).format(now),
        );
        if (inQuietHours(settings, hour)) continue;
        const dueSoon = await this.prisma.task.findMany({
          where: {
            organizationId: org.id,
            status: { in: OPEN_STATUSES },
            assignedToUserId: { not: null },
            dueAt: {
              gt: now,
              lte: new Date(
                now.getTime() + settings.reminderLeadMinutes * 60_000,
              ),
            },
          },
          select: {
            id: true,
            title: true,
            dueAt: true,
            assignedToUserId: true,
            branchId: true,
          },
          take: 300,
        });
        for (const t of dueSoon) {
          await this.notifications
            .notifyOrganization(org.id, {
              type: 'TASK_DUE_SOON',
              category: 'CRM',
              title: `Due soon: ${t.title}`,
              body: `Due at ${new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t.dueAt)}.`,
              actionUrl: `/action-center?task=${t.id}`,
              entityType: 'TASK',
              entityId: t.id,
              dedupeKey: `task-due:${t.id}:${t.dueAt.getTime()}`,
              recipientUserIds: [t.assignedToUserId!],
              branchId: t.branchId,
            })
            .then(() => reminded++)
            .catch(() => undefined);
        }
        const stale = await this.prisma.task.findMany({
          where: {
            organizationId: org.id,
            status: { in: OPEN_STATUSES },
            priority: { in: ['HIGH', 'URGENT'] },
            dueAt: {
              lt: new Date(
                now.getTime() - settings.overdueEscalationHours * 3_600_000,
              ),
            },
          },
          select: { id: true, title: true, branchId: true },
          take: 100,
        });
        for (const t of stale) {
          const recipients = await managerUserIds(
            this.prisma,
            org.id,
            t.branchId,
          );
          if (!recipients.length) continue;
          await this.notifications
            .notifyOrganization(org.id, {
              type: 'TASK_OVERDUE',
              category: 'CRM',
              title: `Overdue: ${t.title}`,
              body: `A high-priority task is more than ${settings.overdueEscalationHours} hours overdue.`,
              priority: 'HIGH',
              actionUrl: `/action-center?task=${t.id}`,
              entityType: 'TASK',
              entityId: t.id,
              dedupeKey: `task-overdue:${t.id}`,
              recipientUserIds: recipients,
              branchId: t.branchId,
            })
            .then(() => escalated++)
            .catch(() => undefined);
        }
      } catch (error) {
        this.logger.error(
          `Reminder sweep failed for ${org.id}: ${String(error)}`,
        );
      }
    }
    return { reminded, escalated };
  }
}
