import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  organizationTimezone,
  zonedBound,
  zonedDate,
  zonedMidnight,
} from '../common/time/zoned';

export const OPEN_STATUSES: TaskStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'BLOCKED',
];
export const MANAGE_PERMISSION = 'tasks.manage';

export const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
} as const;

export const TASK_LIST_SELECT = {
  id: true,
  branchId: true,
  title: true,
  description: true,
  category: true,
  priority: true,
  status: true,
  source: true,
  dueAt: true,
  reason: true,
  sourceType: true,
  sourceId: true,
  checklist: true,
  escalatedAt: true,
  escalationReason: true,
  completedAt: true,
  completionNote: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      memberCode: true,
    },
  },
  lead: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      status: true,
    },
  },
  assignedToUser: { select: PERSON_SELECT },
  createdByUser: { select: PERSON_SELECT },
} satisfies Prisma.TaskSelect;

export function fullName(
  person: { firstName: string; lastName: string | null } | null,
) {
  return person ? `${person.firstName} ${person.lastName ?? ''}`.trim() : null;
}

/** Tenant, plus branch when the caller is branch-restricted. */
export function taskScope(
  organizationId: string,
  branchScope: string | null,
): Prisma.TaskWhereInput {
  return { organizationId, ...(branchScope ? { branchId: branchScope } : {}) };
}

/** The gym's day: bounds of `date` (YYYY-MM-DD) or of today, in its zone. */
export async function gymDay(
  prisma: PrismaService,
  organizationId: string,
  date?: string,
  now: Date = new Date(),
): Promise<{ timezone: string; start: Date; end: Date; key: string }> {
  const timezone = await organizationTimezone(prisma, organizationId);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      timezone,
      start: zonedBound(date, timezone, 'from'),
      end: zonedBound(date, timezone, 'to'),
      key: date,
    };
  }
  const { year, month, day } = zonedDate(now, timezone);
  return {
    timezone,
    start: zonedMidnight(year, month, day, timezone),
    end: zonedMidnight(year, month, day + 1, timezone),
    key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export interface ResolvedSubject {
  memberId: string | null;
  leadId: string | null;
  branchId: string | null;
  phone: string | null;
  name: string | null;
}

/**
 * The member or lead a task or call is about, checked to belong to the
 * caller's organization (and branch, when they are branch-restricted).
 * Anything else is a 404, never a silent cross-tenant link.
 */
export async function resolveSubject(
  prisma: PrismaService | Prisma.TransactionClient,
  organizationId: string,
  branchScope: string | null,
  memberId?: string | null,
  leadId?: string | null,
): Promise<ResolvedSubject> {
  if (memberId && leadId) {
    throw new BadRequestException('Link a member or a lead, not both.');
  }
  if (memberId) {
    const member = await prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: {
        id: true,
        primaryBranchId: true,
        phone: true,
        firstName: true,
        lastName: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return {
      memberId: member.id,
      leadId: null,
      branchId: member.primaryBranchId,
      phone: member.phone,
      name: fullName(member),
    };
  }
  if (leadId) {
    const lead = await prisma.lead.findFirst({
      where: {
        id: leadId,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: {
        id: true,
        branchId: true,
        phone: true,
        firstName: true,
        lastName: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return {
      memberId: null,
      leadId: lead.id,
      branchId: lead.branchId,
      phone: lead.phone,
      name: fullName(lead),
    };
  }
  return {
    memberId: null,
    leadId: null,
    branchId: null,
    phone: null,
    name: null,
  };
}

/** An assignee must be active staff of the same organization -- never a
 * member account, never someone from another gym. */
export async function assertAssignable(
  prisma: PrismaService | Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<void> {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      organizationId,
      status: 'ACTIVE',
      member: null,
      userRoles: { some: { organizationId, role: { key: { not: 'MEMBER' } } } },
    },
    select: { id: true },
  });
  if (!user)
    throw new BadRequestException(
      'Assignee must be an active staff member of this gym.',
    );
}

export async function recordEvent(
  db: PrismaService | Prisma.TransactionClient,
  input: {
    organizationId: string;
    taskId: string;
    actorUserId: string | null;
    type: string;
    body?: string | null;
    data?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.taskEvent.create({
    data: {
      organizationId: input.organizationId,
      taskId: input.taskId,
      actorUserId: input.actorUserId,
      type: input.type,
      body: input.body ?? null,
      data: input.data,
    },
  });
}

/** Active staff in the org who hold `tasks.manage` (optionally for a branch). */
export async function managerUserIds(
  prisma: PrismaService,
  organizationId: string,
  branchId: string | null,
): Promise<string[]> {
  const rows = await prisma.userRole.findMany({
    where: {
      organizationId,
      user: { status: 'ACTIVE' },
      role: {
        rolePermissions: { some: { permission: { key: MANAGE_PERMISSION } } },
      },
      ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : {}),
    },
    select: { userId: true },
    take: 50,
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** Money as the API returns it: a string with two decimals. */
export function money(
  value: Prisma.Decimal | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(2);
}
