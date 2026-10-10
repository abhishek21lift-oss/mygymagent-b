import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CallOutcome,
  Prisma,
  TaskCategory,
  TaskPriority,
} from '@prisma/client';
import { paginate } from '../common/dto/pagination-query.dto';
import {
  organizationTimezone,
  startOfZonedDay,
  zonedBound,
} from '../common/time/zoned';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COLLECTED_PAYMENT_STATUSES } from '../memberships/membership-balance';
import { PrismaService } from '../prisma/prisma.service';
import {
  OPEN_STATUSES,
  PERSON_SELECT,
  assertAssignable,
  money,
  recordEvent,
  resolveSubject,
  taskScope,
} from './action-center.shared';
import { CallAnalysisService } from './call-analysis.service';
import {
  CreateCallLogDto,
  ListCallLogsQueryDto,
  UpdateCallLogDto,
} from './dto/call-logs.dto';
import { TasksService } from './tasks.service';

const DAY_MS = 86_400_000;
/** Outcomes where nobody was actually reached. */
const NOT_REACHED: CallOutcome[] = ['NO_ANSWER', 'BUSY', 'WRONG_NUMBER'];
/** How recent a payment must be to back a PAYMENT_COMPLETED call. */
const PAYMENT_PROOF_DAYS = 60;

const CALL_SELECT = {
  id: true,
  branchId: true,
  phone: true,
  direction: true,
  calledAt: true,
  outcome: true,
  reason: true,
  response: true,
  internalNotes: true,
  amountDiscussed: true,
  promisedPaymentDate: true,
  nextFollowUpAt: true,
  priority: true,
  paymentId: true,
  taskId: true,
  assignedToUserId: true,
  editedAt: true,
  editedByUserId: true,
  analysisStatus: true,
  analysis: true,
  analysisError: true,
  analyzedAt: true,
  createdAt: true,
  member: {
    select: { id: true, firstName: true, lastName: true, memberCode: true },
  },
  lead: { select: { id: true, firstName: true, lastName: true, status: true } },
  recordedByUser: { select: PERSON_SELECT },
  proposals: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      title: true,
      details: true,
      explicit: true,
      evidence: true,
      suggestedDueAt: true,
      dueAtNeedsConfirmation: true,
      suggestedPriority: true,
      amount: true,
      status: true,
      taskId: true,
      decidedAt: true,
    },
  },
} satisfies Prisma.CallLogSelect;

@Injectable()
export class CallLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly analysis: CallAnalysisService,
  ) {}

  /**
   * Save a call and everything it settles, in one transaction: the call,
   * a payment promise the member made (as staff entered it), the next
   * follow-up, a complaint escalation, and the worklist task it closes.
   * The note goes to the AI only after this commits.
   */
  async create(
    user: AuthenticatedUser,
    branchScope: string | null,
    dto: CreateCallLogDto,
  ) {
    const organizationId = user.organizationId!;
    const subject = await resolveSubject(
      this.prisma,
      organizationId,
      branchScope,
      dto.memberId,
      dto.leadId,
    );
    if (!subject.memberId && !subject.leadId) {
      throw new BadRequestException(
        'Pick the member or lead this call was with.',
      );
    }
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const now = new Date();
    const calledAt = dto.calledAt ? new Date(dto.calledAt) : now;
    if (calledAt.getTime() > now.getTime() + 5 * 60_000) {
      throw new BadRequestException('A call cannot be logged in the future.');
    }
    if (dto.assignedToUserId)
      await assertAssignable(this.prisma, organizationId, dto.assignedToUserId);

    const paymentId = await this.verifiedPayment(
      organizationId,
      subject.memberId,
      dto.outcome,
      dto.paymentId,
    );

    // A promise is the member's commitment: only with an amount and a day.
    let promise: { amount: Prisma.Decimal; promisedFor: Date } | null = null;
    if (dto.outcome === 'PAYMENT_PROMISED' && dto.promisedPaymentDate) {
      if (!subject.memberId) {
        throw new BadRequestException(
          'Payment promises are recorded against members, not leads.',
        );
      }
      if (!dto.amountDiscussed || dto.amountDiscussed <= 0) {
        throw new BadRequestException('Enter the amount the member promised.');
      }
      const promisedFor = startOfZonedDay(
        zonedBound(dto.promisedPaymentDate, timezone, 'from'),
        timezone,
      );
      const today = startOfZonedDay(now, timezone);
      if (promisedFor < today)
        throw new BadRequestException('The promised date is in the past.');
      if (promisedFor.getTime() - today.getTime() > 180 * DAY_MS) {
        throw new BadRequestException(
          'The promised date is more than 180 days away.',
        );
      }
      promise = {
        amount: new Prisma.Decimal(dto.amountDiscussed),
        promisedFor,
      };
    }

    let nextFollowUpAt: Date | null = null;
    if (dto.nextFollowUpAt) {
      nextFollowUpAt = new Date(dto.nextFollowUpAt);
      if (nextFollowUpAt.getTime() < now.getTime() - 60 * 60_000) {
        throw new BadRequestException('The next follow-up is in the past.');
      }
      if (nextFollowUpAt.getTime() - now.getTime() > 366 * DAY_MS) {
        throw new BadRequestException(
          'The next follow-up is more than a year away.',
        );
      }
    }

    let workedTask: {
      id: string;
      assignedToUserId: string | null;
      sourceType: string | null;
      sourceId: string | null;
    } | null = null;
    if (dto.taskId) {
      workedTask = await this.prisma.task.findFirst({
        where: { id: dto.taskId, ...taskScope(organizationId, branchScope) },
        select: {
          id: true,
          assignedToUserId: true,
          sourceType: true,
          sourceId: true,
        },
      });
      if (!workedTask) throw new NotFoundException('Task not found');
      if (
        dto.completeTask &&
        workedTask.assignedToUserId &&
        workedTask.assignedToUserId !== user.id &&
        !(await this.tasks.isManager(user))
      ) {
        throw new ForbiddenException('This task is assigned to someone else.');
      }
    }

    const followUpAssignee = dto.assignedToUserId ?? user.id;
    const created = await this.prisma.$transaction(async (tx) => {
      const call = await tx.callLog.create({
        data: {
          organizationId,
          branchId: subject.branchId ?? branchScope ?? user.primaryBranchId,
          memberId: subject.memberId,
          leadId: subject.leadId,
          phone: dto.phone?.trim() || subject.phone,
          direction: dto.direction ?? 'OUTBOUND',
          calledAt,
          outcome: dto.outcome,
          reason: dto.reason?.trim() || null,
          response: dto.response?.trim() || null,
          internalNotes: dto.internalNotes?.trim() || null,
          amountDiscussed:
            dto.amountDiscussed !== undefined
              ? new Prisma.Decimal(dto.amountDiscussed)
              : null,
          promisedPaymentDate: promise?.promisedFor ?? null,
          nextFollowUpAt,
          priority: dto.priority ?? null,
          paymentId,
          taskId: workedTask?.id ?? null,
          recordedByUserId: user.id,
          assignedToUserId: dto.assignedToUserId ?? null,
        },
        select: { id: true, branchId: true },
      });
      const base = {
        organizationId,
        branchId: call.branchId,
        memberId: subject.memberId,
        leadId: subject.leadId,
        createdByUserId: user.id,
      };

      if (promise) {
        const row = await tx.paymentPromise.create({
          data: {
            organizationId,
            branchId: call.branchId,
            memberId: subject.memberId!,
            callLogId: call.id,
            amount: promise.amount,
            promisedFor: promise.promisedFor,
            note: dto.response?.trim().slice(0, 500) || null,
            createdByUserId: user.id,
          },
          select: { id: true },
        });
        await this.createTask(tx, user.id, {
          ...base,
          title: `Payment promised: ₹${Number(promise.amount).toLocaleString('en-IN')} — ${subject.name ?? 'member'}`,
          category: 'PAYMENT_PROMISE',
          priority: 'HIGH',
          dueAt: new Date(promise.promisedFor.getTime() + 10 * 60 * 60_000),
          assignedToUserId: followUpAssignee,
          dedupeKey: `promise:${row.id}`,
          sourceType: 'PAYMENT_PROMISE',
          sourceId: row.id,
          reason:
            'The member promised this payment on a call. It closes itself once a payment covers it.',
        });
      }

      if (nextFollowUpAt) {
        await this.createTask(tx, user.id, {
          ...base,
          title: `Call back ${subject.name ?? ''}`.trim(),
          description: dto.response?.trim().slice(0, 500) || null,
          category: subject.leadId ? 'LEAD_FOLLOW_UP' : 'CALL',
          priority: dto.priority ?? 'MEDIUM',
          dueAt: nextFollowUpAt,
          assignedToUserId: followUpAssignee,
          dedupeKey: `call-followup:${call.id}`,
          sourceType: 'CALL_LOG',
          sourceId: call.id,
          reason: 'Follow-up scheduled when the last call was logged.',
        });
      }

      let complaintTaskId: string | null = null;
      if (dto.outcome === 'COMPLAINT_RAISED') {
        complaintTaskId = await this.createTask(tx, user.id, {
          ...base,
          title: `Complaint: ${subject.name ?? 'caller'} — manager to respond`,
          description: dto.response?.trim().slice(0, 1000) || null,
          category: 'COMPLAINT',
          priority: 'URGENT',
          dueAt: now,
          assignedToUserId: null,
          dedupeKey: `complaint:${call.id}`,
          sourceType: 'CALL_LOG',
          sourceId: call.id,
          reason: 'A complaint was raised on a call.',
          escalated: true,
        });
      }

      if (workedTask) {
        await recordEvent(tx, {
          organizationId,
          taskId: workedTask.id,
          actorUserId: user.id,
          type: 'CALL_LOGGED',
          body: dto.response?.trim().slice(0, 300) || null,
          data: { callLogId: call.id, outcome: dto.outcome },
        });
        if (dto.completeTask) {
          const { count } = await tx.task.updateMany({
            where: {
              id: workedTask.id,
              organizationId,
              status: { in: OPEN_STATUSES },
            },
            data: {
              status: 'COMPLETED',
              completedAt: now,
              completedByUserId: user.id,
              completionNote: `Call: ${dto.outcome.replace(/_/g, ' ').toLowerCase()}`,
            },
          });
          if (count) {
            await recordEvent(tx, {
              organizationId,
              taskId: workedTask.id,
              actorUserId: user.id,
              type: 'STATUS_CHANGED',
              data: { to: 'COMPLETED', callLogId: call.id },
            });
            await this.tasks.completeLinkedFollowUp(
              tx,
              organizationId,
              workedTask.sourceType,
              workedTask.sourceId,
            );
          }
        }
      }

      // Reaching a new enquiry moves it to Contacted -- what staff recorded,
      // not an inference. Nothing else about the lead changes here.
      if (subject.leadId && !NOT_REACHED.includes(dto.outcome)) {
        await tx.lead.updateMany({
          where: { id: subject.leadId, organizationId, status: 'NEW' },
          data: { status: 'CONTACTED' },
        });
      }
      return { id: call.id, branchId: call.branchId, complaintTaskId };
    });

    if (created.complaintTaskId) {
      await this.tasks.notifyManagers(organizationId, created.branchId, {
        type: 'TASK_ESCALATED',
        title: `Complaint from ${subject.name ?? 'a caller'}`,
        body: (dto.response ?? 'A complaint was raised on a call.').slice(
          0,
          160,
        ),
        taskId: created.complaintTaskId,
        dedupeKey: `complaint:${created.id}`,
        actorUserId: user.id,
      });
    }
    await this.analysis.request(organizationId, created.id);
    return this.get(user, branchScope, created.id);
  }

  private async createTask(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    input: {
      organizationId: string;
      branchId: string | null;
      memberId: string | null;
      leadId: string | null;
      createdByUserId: string;
      title: string;
      description?: string | null;
      category: TaskCategory;
      priority: TaskPriority;
      dueAt: Date;
      assignedToUserId: string | null;
      dedupeKey: string;
      sourceType: string;
      sourceId: string;
      reason: string;
      escalated?: boolean;
    },
  ): Promise<string> {
    const { escalated, ...data } = input;
    const task = await tx.task.create({
      data: {
        ...data,
        source: 'MANUAL',
        ...(escalated
          ? {
              escalatedAt: new Date(),
              escalatedByUserId: actorUserId,
              escalationReason: input.reason,
            }
          : {}),
      },
      select: { id: true },
    });
    await recordEvent(tx, {
      organizationId: input.organizationId,
      taskId: task.id,
      actorUserId,
      type: 'CREATED',
      data: { from: input.sourceType, sourceId: input.sourceId },
    });
    return task.id;
  }

  /**
   * A call can only say a payment is complete when the payment system
   * already has one: a collected payment by this member, recent enough to
   * be the one discussed. Anything else is a 400 -- staff record the
   * payment first, then the call.
   */
  private async verifiedPayment(
    organizationId: string,
    memberId: string | null,
    outcome: CallOutcome,
    paymentId?: string,
  ): Promise<string | null> {
    if (outcome !== 'PAYMENT_COMPLETED' && !paymentId) return null;
    if (!memberId) {
      throw new BadRequestException(
        'A completed payment can only be linked to a member.',
      );
    }
    if (!paymentId) {
      throw new BadRequestException(
        'Payment completed needs the recorded payment. Record it under Billing first, then pick it here.',
      );
    }
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        organizationId,
        memberId,
        status: { in: [...COLLECTED_PAYMENT_STATUSES] },
        createdAt: { gte: new Date(Date.now() - PAYMENT_PROOF_DAYS * DAY_MS) },
      },
      select: { id: true },
    });
    if (!payment) {
      throw new BadRequestException(
        'That payment was not found for this member, or is not collected.',
      );
    }
    return payment.id;
  }

  async get(user: AuthenticatedUser, branchScope: string | null, id: string) {
    const call = await this.prisma.callLog.findFirst({
      where: {
        id,
        organizationId: user.organizationId!,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: CALL_SELECT,
    });
    if (!call) throw new NotFoundException('Call not found');
    return this.present(call);
  }

  private present<
    T extends {
      amountDiscussed: Prisma.Decimal | null;
      proposals: { amount: Prisma.Decimal | null }[];
    },
  >(call: T) {
    return {
      ...call,
      amountDiscussed: money(call.amountDiscussed),
      proposals: call.proposals.map((p) => ({ ...p, amount: money(p.amount) })),
    };
  }

  async list(
    user: AuthenticatedUser,
    branchScope: string | null,
    query: ListCallLogsQueryDto,
  ) {
    const organizationId = user.organizationId!;
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const search = query.search?.trim().slice(0, 100);
    const where: Prisma.CallLogWhereInput = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.recordedByUserId
        ? { recordedByUserId: query.recordedByUserId }
        : {}),
      ...(query.from || query.to
        ? {
            calledAt: {
              ...(query.from
                ? { gte: zonedBound(query.from, timezone, 'from') }
                : {}),
              ...(query.to ? { lt: zonedBound(query.to, timezone, 'to') } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { response: { contains: search, mode: 'insensitive' } },
              { internalNotes: { contains: search, mode: 'insensitive' } },
              { reason: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.callLog.findMany({
        where,
        select: CALL_SELECT,
        orderBy: { calledAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.callLog.count({ where }),
    ]);
    return paginate(
      items.map((c) => this.present(c)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /** Correct a call. The recorder or a manager only; who and when is kept,
   * and a changed note is analysed again. */
  async update(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
    dto: UpdateCallLogDto,
  ) {
    const organizationId = user.organizationId!;
    const call = await this.prisma.callLog.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: {
        id: true,
        memberId: true,
        recordedByUserId: true,
        response: true,
        internalNotes: true,
        reason: true,
        outcome: true,
        paymentId: true,
      },
    });
    if (!call) throw new NotFoundException('Call not found');
    if (
      call.recordedByUserId !== user.id &&
      !(await this.tasks.isManager(user))
    ) {
      throw new ForbiddenException(
        'Only the person who logged this call, or a manager, can edit it.',
      );
    }
    const outcome = dto.outcome ?? call.outcome;
    const paymentId =
      outcome === 'PAYMENT_COMPLETED' || dto.paymentId
        ? await this.verifiedPayment(
            organizationId,
            call.memberId,
            outcome,
            dto.paymentId ?? call.paymentId ?? undefined,
          )
        : call.paymentId;
    const textChanged =
      (dto.response !== undefined &&
        dto.response.trim() !== (call.response ?? '')) ||
      (dto.internalNotes !== undefined &&
        dto.internalNotes.trim() !== (call.internalNotes ?? '')) ||
      (dto.reason !== undefined && dto.reason.trim() !== (call.reason ?? ''));
    await this.prisma.callLog.update({
      where: { id },
      data: {
        ...(dto.outcome ? { outcome: dto.outcome } : {}),
        ...(dto.response !== undefined
          ? { response: dto.response.trim() || null }
          : {}),
        ...(dto.internalNotes !== undefined
          ? { internalNotes: dto.internalNotes.trim() || null }
          : {}),
        ...(dto.reason !== undefined
          ? { reason: dto.reason.trim() || null }
          : {}),
        paymentId,
        editedAt: new Date(),
        editedByUserId: user.id,
      },
    });
    if (textChanged) await this.analysis.request(organizationId, id);
    return this.get(user, branchScope, id);
  }

  async retryAnalysis(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
  ) {
    await this.get(user, branchScope, id); // scope check
    await this.analysis.request(user.organizationId!, id, { retry: true });
    return this.get(user, branchScope, id);
  }
}
