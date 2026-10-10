import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActionProposalKind, Prisma, TaskCategory } from '@prisma/client';
import { organizationTimezone, startOfZonedDay } from '../common/time/zoned';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import {
  PERSON_SELECT,
  assertAssignable,
  fullName,
  money,
  recordEvent,
} from './action-center.shared';
import { ApproveProposalDto, ListProposalsQueryDto } from './dto/proposals.dto';
import { TasksService } from './tasks.service';

const CATEGORY: Record<ActionProposalKind, TaskCategory> = {
  FOLLOW_UP_CALL: 'CALL',
  PAYMENT_PROMISE: 'PAYMENT_PROMISE',
  RENEWAL_FOLLOW_UP: 'RENEWAL',
  TRIAL_VISIT: 'TRIAL',
  MANAGER_ESCALATION: 'COMPLAINT',
  OTHER: 'FOLLOW_UP',
};

/**
 * AI proposals from call notes: staff approve (as suggested or edited),
 * reassign, reschedule, or reject. Approval only ever creates a task --
 * and, for a payment promise, the promise record. It never records a
 * payment, renews, cancels or messages anyone.
 */
@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  private scope(
    organizationId: string,
    branchScope: string | null,
  ): Prisma.ActionProposalWhereInput {
    return {
      organizationId,
      ...(branchScope ? { callLog: { branchId: branchScope } } : {}),
    };
  }

  async list(
    user: AuthenticatedUser,
    branchScope: string | null,
    query: ListProposalsQueryDto,
  ) {
    const status = query.status ?? 'PENDING';
    const rows = await this.prisma.actionProposal.findMany({
      where: {
        ...this.scope(user.organizationId!, branchScope),
        ...(status === 'ALL' ? {} : { status }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        callLog: {
          select: {
            id: true,
            calledAt: true,
            outcome: true,
            response: true,
            assignedToUserId: true,
            analysis: true,
            member: { select: { id: true, firstName: true, lastName: true } },
            lead: { select: { id: true, firstName: true, lastName: true } },
            recordedByUser: { select: PERSON_SELECT },
          },
        },
      },
    });
    return rows.map((p) => ({
      ...p,
      amount: money(p.amount),
      subjectName: fullName(p.callLog.member ?? p.callLog.lead ?? null),
      summary:
        (p.callLog.analysis as { summary?: string } | null)?.summary ?? null,
      callLog: { ...p.callLog, analysis: undefined },
    }));
  }

  async approve(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
    dto: ApproveProposalDto,
  ) {
    const organizationId = user.organizationId!;
    const proposal = await this.prisma.actionProposal.findFirst({
      where: { id, ...this.scope(organizationId, branchScope) },
      include: {
        callLog: {
          select: {
            id: true,
            branchId: true,
            calledAt: true,
            assignedToUserId: true,
            memberId: true,
            leadId: true,
          },
        },
      },
    });
    if (!proposal) throw new NotFoundException('Suggestion not found');
    if (proposal.status !== 'PENDING') {
      throw new ConflictException('This suggestion was already decided.');
    }
    // An unclear date is never guessed: staff must name the day.
    if (proposal.dueAtNeedsConfirmation && !dto.dueAt) {
      throw new BadRequestException(
        'The note did not give a clear date. Pick one before approving.',
      );
    }
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : proposal.suggestedDueAt;
    if (!dueAt) throw new BadRequestException('Pick a due date.');
    const assignee =
      dto.assignedToUserId ?? proposal.callLog.assignedToUserId ?? user.id;
    if (assignee !== user.id)
      await assertAssignable(this.prisma, organizationId, assignee);

    const isPromise = proposal.kind === 'PAYMENT_PROMISE';
    const amount =
      dto.amount ?? (proposal.amount ? Number(proposal.amount) : null);
    if (isPromise) {
      if (!proposal.memberId)
        throw new BadRequestException('Payment promises need a member.');
      if (!amount) throw new BadRequestException('Enter the promised amount.');
    }
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const title = (dto.title ?? proposal.title).trim();
    const reason = proposal.explicit
      ? `The member said this on the call of ${proposal.callLog.calledAt.toISOString().slice(0, 10)}${proposal.evidence ? `: "${proposal.evidence}"` : ''}`
      : `Suggested by AI from the call note of ${proposal.callLog.calledAt.toISOString().slice(0, 10)}; approved by staff.`;

    const taskId = await this.prisma.$transaction(async (tx) => {
      // Claim it: two people approving at once create one task, not two.
      const { count } = await tx.actionProposal.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          decidedByUserId: user.id,
          decidedAt: new Date(),
        },
      });
      if (count === 0)
        throw new ConflictException('This suggestion was already decided.');

      let dedupeKey = `proposal:${id}`;
      let sourceType = 'CALL_LOG';
      let sourceId = proposal.callLogId;
      if (isPromise) {
        const promise = await tx.paymentPromise.create({
          data: {
            organizationId,
            branchId: proposal.callLog.branchId,
            memberId: proposal.memberId!,
            callLogId: proposal.callLogId,
            amount: new Prisma.Decimal(amount!),
            promisedFor: startOfZonedDay(dueAt, timezone),
            note: proposal.evidence,
            createdByUserId: user.id,
          },
          select: { id: true },
        });
        dedupeKey = `promise:${promise.id}`;
        sourceType = 'PAYMENT_PROMISE';
        sourceId = promise.id;
      }
      const escalate = proposal.kind === 'MANAGER_ESCALATION';
      const task = await tx.task.create({
        data: {
          organizationId,
          branchId: proposal.callLog.branchId,
          title:
            isPromise && !dto.title
              ? `Payment promised: ₹${amount!.toLocaleString('en-IN')}`
              : title,
          description: dto.description?.trim() || proposal.details,
          category:
            CATEGORY[proposal.kind] === 'CALL' && proposal.leadId
              ? 'LEAD_FOLLOW_UP'
              : CATEGORY[proposal.kind],
          priority: dto.priority ?? proposal.suggestedPriority,
          source: 'AI_SUGGESTION',
          dueAt,
          memberId: proposal.memberId,
          leadId: proposal.leadId,
          assignedToUserId: assignee,
          createdByUserId: user.id,
          dedupeKey,
          reason,
          sourceType,
          sourceId,
          ...(escalate
            ? {
                escalatedAt: new Date(),
                escalatedByUserId: user.id,
                escalationReason: title,
              }
            : {}),
        },
        select: { id: true, branchId: true },
      });
      await tx.actionProposal.update({
        where: { id },
        data: { taskId: task.id },
      });
      await recordEvent(tx, {
        organizationId,
        taskId: task.id,
        actorUserId: user.id,
        type: 'CREATED',
        body: 'Approved from an AI suggestion.',
        data: {
          proposalId: id,
          callLogId: proposal.callLogId,
          edited: Boolean(dto.title || dto.dueAt || dto.priority || dto.amount),
        },
      });
      return task.id;
    });

    if (proposal.kind === 'MANAGER_ESCALATION') {
      await this.tasks.notifyManagers(
        organizationId,
        proposal.callLog.branchId,
        {
          type: 'TASK_ESCALATED',
          title: `Escalated: ${title}`,
          body: 'A call note was escalated for a manager.',
          taskId,
          dedupeKey: `proposal-escalated:${id}`,
          actorUserId: user.id,
        },
      );
    }
    return this.tasks.get(user, branchScope, taskId);
  }

  async reject(
    user: AuthenticatedUser,
    branchScope: string | null,
    id: string,
    reason?: string,
  ) {
    const organizationId = user.organizationId!;
    const proposal = await this.prisma.actionProposal.findFirst({
      where: { id, ...this.scope(organizationId, branchScope) },
      select: { id: true },
    });
    if (!proposal) throw new NotFoundException('Suggestion not found');
    const { count } = await this.prisma.actionProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedByUserId: user.id,
        decidedAt: new Date(),
        rejectReason: reason?.trim() || null,
      },
    });
    if (count === 0)
      throw new ConflictException('This suggestion was already decided.');
    return { id, status: 'REJECTED' as const };
  }
}
