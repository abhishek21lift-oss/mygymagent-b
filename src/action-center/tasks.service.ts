import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { paginate } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import {
  MANAGE_PERMISSION,
  OPEN_STATUSES,
  PERSON_SELECT,
  TASK_LIST_SELECT,
  assertAssignable,
  fullName,
  gymDay,
  managerUserIds,
  recordEvent,
  resolveSubject,
  taskScope,
} from './action-center.shared';
import {
  CreateTaskDto,
  ListTasksQueryDto,
  UpdateTaskDto,
} from './dto/tasks.dto';

const PRIORITY_RANK: Record<TaskPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
};

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
  ) {}

  isManager(user: AuthenticatedUser): Promise<boolean> {
    return this.permissions.hasPermission(
      user.id,
      user.organizationId,
      MANAGE_PERMISSION,
    );
  }

  async list(
    user: AuthenticatedUser,
    branchScope: string | null,
    query: ListTasksQueryDto,
  ) {
    const organizationId = user.organizationId!;
    const day = await gymDay(this.prisma, organizationId, query.date);
    const where: Prisma.TaskWhereInput = {
      ...taskScope(organizationId, branchScope ?? query.branchId ?? null),
      ...(query.category ? { category: query.category } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.assignedToUserId
        ? { assignedToUserId: query.assignedToUserId }
        : {}),
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.search
        ? {
            title: {
              contains: query.search.slice(0, 100),
              mode: 'insensitive',
            },
          }
        : {}),
    };
    const open = { status: { in: OPEN_STATUSES } };
    let orderBy: Prisma.TaskOrderByWithRelationInput[] = [
      { priority: 'desc' },
      { dueAt: 'asc' },
    ];
    switch (query.view) {
      case 'my':
        Object.assign(where, open, { assignedToUserId: user.id });
        break;
      case 'today':
        Object.assign(where, {
          dueAt: { gte: day.start, lt: day.end },
          status: { not: 'CANCELLED' },
        });
        break;
      case 'upcoming':
        Object.assign(where, open, { dueAt: { gte: day.end } });
        orderBy = [{ dueAt: 'asc' }];
        break;
      case 'overdue':
        Object.assign(where, open, { dueAt: { lt: day.start } });
        orderBy = [{ dueAt: 'asc' }];
        break;
      case 'completed':
        Object.assign(where, { status: 'COMPLETED' });
        orderBy = [{ completedAt: 'desc' }];
        break;
      case 'team':
        Object.assign(where, open);
        break;
      case 'unassigned':
        Object.assign(where, open, { assignedToUserId: null });
        break;
      case 'escalated':
        Object.assign(where, open, { escalatedAt: { not: null } });
        break;
      case 'ai':
        Object.assign(where, open, { source: 'AI_SUGGESTION' });
        break;
      default:
        // The worklist: everything still open that is due by end of day,
        // overdue included.
        Object.assign(where, open, { dueAt: { lt: day.end } });
    }
    if (query.status) where.status = query.status;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        select: TASK_LIST_SELECT,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.task.count({ where }),
    ]);
    return paginate(
      items.map((t) => this.present(t, day.start)),
      total,
      query.page,
      query.pageSize,
    );
  }

  present<T extends { status: TaskStatus; dueAt: Date }>(
    task: T,
    dayStart: Date,
  ) {
    return {
      ...task,
      isOverdue:
        OPEN_STATUSES.includes(task.status) &&
        task.dueAt.getTime() < dayStart.getTime(),
    };
  }

  async get(user: AuthenticatedUser, branchScope: string | null, id: string) {
    const organizationId = user.organizationId!;
    const task = await this.prisma.task.findFirst({
      where: { id, ...taskScope(organizationId, branchScope) },
      select: {
        ...TASK_LIST_SELECT,
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
        callLogs: {
          orderBy: { calledAt: 'desc' },
          take: 20,
          select: {
            id: true,
            calledAt: true,
            outcome: true,
            response: true,
            recordedByUser: { select: PERSON_SELECT },
          },
        },
        proposals: {
          select: { id: true, kind: true, status: true, callLogId: true },
        },
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    const actorIds = [
      ...new Set(task.events.map((e) => e.actorUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds }, organizationId },
          select: PERSON_SELECT,
        })
      : [];
    const names = new Map(actors.map((a) => [a.id, fullName(a)]));
    const day = await gymDay(this.prisma, organizationId);
    return {
      ...this.present(task, day.start),
      events: task.events.map((e) => ({
        ...e,
        actorName: e.actorUserId
          ? (names.get(e.actorUserId) ?? 'Former staff')
          : 'System',
      })),
    };
  }

  async create(
    user: AuthenticatedUser,
    branchScope: string | null,
    dto: CreateTaskDto,
  ) {
    const organizationId = user.organizationId!;
    const subject = await resolveSubject(
      this.prisma,
      organizationId,
      branchScope,
      dto.memberId,
      dto.leadId,
    );
    if (dto.assignedToUserId) {
      await assertAssignable(this.prisma, organizationId, dto.assignedToUserId);
    }
    const dueAt = new Date(dto.dueAt);
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          organizationId,
          branchId: subject.branchId ?? branchScope ?? user.primaryBranchId,
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          category: dto.category ?? 'GENERAL',
          priority: dto.priority ?? 'MEDIUM',
          source: 'MANUAL',
          dueAt,
          memberId: subject.memberId,
          leadId: subject.leadId,
          assignedToUserId: dto.assignedToUserId ?? null,
          createdByUserId: user.id,
          checklist: dto.checklist
            ? (dto.checklist as unknown as Prisma.InputJsonValue)
            : undefined,
        },
        select: TASK_LIST_SELECT,
      });
      await recordEvent(tx, {
        organizationId,
        taskId: task.id,
        actorUserId: user.id,
        type: 'CREATED',
      });
      return task;
    });
  }

  /**
   * One update path for every edit: status, reschedule, reassignment,
   * checklist. Front-desk staff (tasks.work) may change their own and
   * unassigned tasks and may take or release one; anything else needs
   * tasks.manage. Optimistic: a task changed since it was read is a 409.
   */
  async update(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
    dto: UpdateTaskDto,
  ) {
    const organizationId = user.organizationId!;
    const before = await this.prisma.task.findFirst({
      where: { id, ...taskScope(organizationId, branchScope) },
    });
    if (!before) throw new NotFoundException('Task not found');
    const manager = await this.isManager(user);
    const mine =
      before.assignedToUserId === user.id || before.assignedToUserId === null;
    if (!manager && !mine) {
      throw new ForbiddenException('This task is assigned to someone else.');
    }

    const data: Prisma.TaskUncheckedUpdateManyInput = {};
    const events: {
      type: string;
      body?: string;
      data?: Prisma.InputJsonValue;
    }[] = [];

    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined)
      data.description = dto.description.trim() || null;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.priority !== undefined && dto.priority !== before.priority) {
      data.priority = dto.priority;
      events.push({
        type: 'UPDATED',
        data: { priority: [before.priority, dto.priority] },
      });
    }
    if (dto.checklist !== undefined) {
      data.checklist = dto.checklist as unknown as Prisma.InputJsonValue;
    }
    if (dto.dueAt !== undefined) {
      const dueAt = new Date(dto.dueAt);
      if (dueAt.getTime() !== before.dueAt.getTime()) {
        data.dueAt = dueAt;
        events.push({
          type: 'RESCHEDULED',
          data: { from: before.dueAt.toISOString(), to: dueAt.toISOString() },
        });
      }
    }
    if (
      dto.assignedToUserId !== undefined &&
      dto.assignedToUserId !== before.assignedToUserId
    ) {
      const next = dto.assignedToUserId;
      if (!manager) {
        const taking = next === user.id && before.assignedToUserId === null;
        const releasing = next === null && before.assignedToUserId === user.id;
        if (!taking && !releasing) {
          throw new ForbiddenException(
            'Only a manager can reassign tasks to someone else.',
          );
        }
      }
      if (next) await assertAssignable(this.prisma, organizationId, next);
      data.assignedToUserId = next;
      events.push({
        type: 'ASSIGNED',
        data: { from: before.assignedToUserId, to: next },
      });
    }
    if (dto.status !== undefined && dto.status !== before.status) {
      Object.assign(data, this.statusChange(before.status, dto, user.id));
      events.push({
        type: 'STATUS_CHANGED',
        body:
          dto.status === 'COMPLETED' ? dto.completionNote : dto.cancelReason,
        data: { from: before.status, to: dto.status },
      });
    } else if (
      dto.completionNote !== undefined &&
      before.status === 'COMPLETED'
    ) {
      data.completionNote = dto.completionNote.trim() || null;
    }
    if (Object.keys(data).length === 0) return this.get(user, branchScope, id);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.task.updateMany({
        where: { id, organizationId, updatedAt: before.updatedAt },
        data,
      });
      if (count === 0) {
        throw new ConflictException(
          'This task was changed by someone else. Reload and try again.',
        );
      }
      for (const event of events) {
        await recordEvent(tx, {
          organizationId,
          taskId: id,
          actorUserId: user.id,
          ...event,
        });
      }
      if (dto.status === 'COMPLETED') {
        await this.completeLinkedFollowUp(
          tx,
          organizationId,
          before.sourceType,
          before.sourceId,
        );
      }
    });
    return this.get(user, branchScope, id);
  }

  private statusChange(
    from: TaskStatus,
    dto: UpdateTaskDto,
    userId: string,
  ): Prisma.TaskUpdateManyMutationInput {
    const to = dto.status!;
    if (to === 'COMPLETED') {
      return {
        status: to,
        completedAt: new Date(),
        completedByUserId: userId,
        completionNote: dto.completionNote?.trim() || null,
        cancelledAt: null,
        cancelReason: null,
      };
    }
    if (to === 'CANCELLED') {
      return {
        status: to,
        cancelledAt: new Date(),
        cancelReason: dto.cancelReason?.trim() || null,
        completedAt: null,
        completedByUserId: null,
      };
    }
    // Back to open (reopen, start, block).
    const reopening = from === 'COMPLETED' || from === 'CANCELLED';
    return {
      status: to,
      ...(reopening
        ? {
            completedAt: null,
            completedByUserId: null,
            cancelledAt: null,
            cancelReason: null,
          }
        : {}),
    };
  }

  /** Finishing the task finishes the follow-up it was made from. */
  async completeLinkedFollowUp(
    tx: Prisma.TransactionClient,
    organizationId: string,
    sourceType: string | null,
    sourceId: string | null,
  ): Promise<void> {
    if (!sourceId) return;
    if (sourceType === 'MEMBER_FOLLOW_UP') {
      await tx.memberFollowUp.updateMany({
        where: { id: sourceId, organizationId, completedAt: null },
        data: { completedAt: new Date() },
      });
    } else if (sourceType === 'LEAD_FOLLOW_UP') {
      await tx.leadFollowUp.updateMany({
        where: { id: sourceId, organizationId, completedAt: null },
        data: { completedAt: new Date() },
      });
    }
  }

  async comment(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
    body: string,
  ) {
    const organizationId = user.organizationId!;
    const task = await this.prisma.task.findFirst({
      where: { id, ...taskScope(organizationId, branchScope) },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    await recordEvent(this.prisma, {
      organizationId,
      taskId: id,
      actorUserId: user.id,
      type: 'COMMENT',
      body: body.trim(),
    });
    await this.prisma.task.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
    return this.get(user, branchScope, id);
  }

  /**
   * Flag for a manager: URGENT, marked escalated, and every manager of the
   * branch hears about it. Anyone who can see the task may escalate it --
   * a receptionist with a complaint should not need permission to ask.
   */
  async escalate(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
    reason: string,
  ) {
    const organizationId = user.organizationId!;
    const task = await this.prisma.task.findFirst({
      where: { id, ...taskScope(organizationId, branchScope) },
      select: {
        id: true,
        title: true,
        branchId: true,
        status: true,
        escalatedAt: true,
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!OPEN_STATUSES.includes(task.status)) {
      throw new BadRequestException('Only an open task can be escalated.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id },
        data: {
          priority: 'URGENT',
          escalatedAt: new Date(),
          escalatedByUserId: user.id,
          escalationReason: reason.trim(),
        },
      });
      await recordEvent(tx, {
        organizationId,
        taskId: id,
        actorUserId: user.id,
        type: 'ESCALATED',
        body: reason.trim(),
      });
    });
    await this.notifyManagers(organizationId, task.branchId, {
      type: 'TASK_ESCALATED',
      title: `Escalated: ${task.title}`,
      body: `${user.firstName} escalated a task: ${reason.trim().slice(0, 160)}`,
      taskId: id,
      dedupeKey: `task-escalated:${id}:${Date.now()}`,
      actorUserId: user.id,
    });
    return this.get(user, branchScope, id);
  }

  async notifyManagers(
    organizationId: string,
    branchId: string | null,
    input: {
      type: string;
      title: string;
      body: string;
      taskId: string;
      dedupeKey: string;
      actorUserId?: string | null;
    },
  ): Promise<void> {
    const recipients = (
      await managerUserIds(this.prisma, organizationId, branchId)
    ).filter((id) => id !== input.actorUserId);
    if (!recipients.length) return;
    await this.notifications
      .notifyOrganization(organizationId, {
        type: input.type,
        category: 'CRM',
        title: input.title,
        body: input.body,
        priority: 'HIGH',
        actionUrl: `/action-center?task=${input.taskId}`,
        entityType: 'TASK',
        entityId: input.taskId,
        dedupeKey: input.dedupeKey,
        recipientUserIds: recipients,
        actorUserId: input.actorUserId ?? null,
        branchId,
      })
      .catch(() => undefined);
  }

  /** Higher rank first, then earlier due. */
  static compare(
    a: { priority: TaskPriority; dueAt: Date },
    b: { priority: TaskPriority; dueAt: Date },
  ) {
    return (
      PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
      a.dueAt.getTime() - b.dueAt.getTime()
    );
  }
}
