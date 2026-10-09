import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import {
  DomainEvent,
  type PtSessionBookedEvent,
  type PtSessionCompletedEvent,
  type PtSessionCancelledEvent,
} from '../events/domain-events';
import {
  assertTrainerFree,
  trainerUserId,
} from '../common/scheduling/trainer-clash';
import { PrismaService } from '../prisma/prisma.service';
import type { BookPtSessionDto } from './dto/book-pt-session.dto';
import type { UpdatePtSessionDto } from './dto/update-pt-session.dto';
import { MembersService } from '../members/members.service';
import { BranchesService } from '../branches/branches.service';
import { PtPackagesService } from '../pt-packages/pt-packages.service';

@Injectable()
export class PtSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly membersService: MembersService,
    private readonly branchesService: BranchesService,
    private readonly ptPackagesService: PtPackagesService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    trainerId?: string,
    branchId?: string,
    startFrom?: Date,
    endTo?: Date,
    branchScope: string | null = null,
  ) {
    // A branch-scoped caller reads only their own branch, whatever branch
    // they ask for; this list used to answer for the whole organization.
    const and: Prisma.PtSessionWhereInput[] = [
      ...(branchId ? [{ branchId }] : []),
      ...(branchScope ? [{ branchId: branchScope }] : []),
      ...(startFrom ? [{ startTime: { gte: startFrom } }] : []),
      ...(endTo ? [{ endTime: { lte: endTo } }] : []),
    ];
    const where: Prisma.PtSessionWhereInput = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(trainerId ? { trainerId } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.ptSession.findMany({
        where,
        ...skipTake(query),
        orderBy: { startTime: query.order ?? 'desc' },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              memberCode: true,
            },
          },
          trainer: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          branch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.ptSession.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
  ) {
    const session = await this.prisma.ptSession.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        trainer: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!session) throw new NotFoundException('PT session not found');
    return session;
  }

  private async assertMemberBelongsToOrg(
    organizationId: string,
    memberId: string,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!member)
      throw new BadRequestException('Member not found in this organization');
  }
  /**
   * For a caller limited to their own clients (a trainer): the member must
   * be assigned to them, and any trainer named must be them. Without this
   * a trainer could book, re-assign or complete any member's session --
   * completing one draws down the member's package and counts towards the
   * trainer's commission.
   */
  private async assertWithinAssignment(
    organizationId: string,
    assignmentScope: string | null,
    memberId: string | undefined,
    trainerId: string | null | undefined,
  ) {
    if (!assignmentScope) return;
    if (memberId) {
      const assigned = await this.prisma.member.findFirst({
        where: {
          id: memberId,
          organizationId,
          assignedTrainerId: assignmentScope,
        },
        select: { id: true },
      });
      if (!assigned)
        throw new ForbiddenException('That member is not assigned to you');
    }
    if (trainerId) {
      const owner = await trainerUserId(this.prisma, organizationId, trainerId);
      if (owner !== assignmentScope)
        throw new ForbiddenException('You can only book sessions for yourself');
    }
  }

  /** The session's member is assigned to the caller, or the caller is its
   * trainer. */
  private async assertSessionWithinAssignment(
    organizationId: string,
    assignmentScope: string | null,
    session: { memberId: string; trainerId: string | null },
  ) {
    if (!assignmentScope) return;
    if (session.trainerId) {
      const owner = await trainerUserId(
        this.prisma,
        organizationId,
        session.trainerId,
      );
      if (owner === assignmentScope) return;
    }
    const assigned = await this.prisma.member.findFirst({
      where: {
        id: session.memberId,
        organizationId,
        assignedTrainerId: assignmentScope,
      },
      select: { id: true },
    });
    if (!assigned) throw new NotFoundException('PT session not found');
  }

  private async assertTrainerBelongsToOrg(
    organizationId: string,
    trainerId: string,
  ) {
    if (!trainerId) return;
    const trainer = await this.prisma.staffProfile.findFirst({
      where: { id: trainerId, organizationId },
    });
    if (!trainer)
      throw new BadRequestException('Trainer not found in this organization');
  }

  /** `trainerId` is a StaffProfile id; the shared check is keyed by user. */
  private async assertTrainerFreeAcrossCalendar(
    organizationId: string,
    trainerId: string,
    start: Date,
    end: Date,
    ignorePtSessionId?: string,
  ) {
    const userId = await trainerUserId(this.prisma, organizationId, trainerId);
    if (!userId) return;
    await assertTrainerFree(this.prisma, {
      organizationId,
      userId,
      start,
      end,
      ignorePtSessionId,
    });
  }

  private async assertBranchBelongsToOrg(
    organizationId: string,
    branchId: string,
  ) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId },
    });
    if (!branch)
      throw new BadRequestException('Branch not found in this organization');
  }

  async book(
    organizationId: string,
    dto: BookPtSessionDto,
    bookedByUserId: string,
    assignmentScope: string | null = null,
  ) {
    await this.assertMemberBelongsToOrg(organizationId, dto.memberId);
    await this.assertWithinAssignment(
      organizationId,
      assignmentScope,
      dto.memberId,
      dto.trainerId,
    );
    if (dto.trainerId)
      await this.assertTrainerBelongsToOrg(organizationId, dto.trainerId);
    await this.assertBranchBelongsToOrg(organizationId, dto.branchId);
    if (dto.startTime >= dto.endTime)
      throw new BadRequestException(
        'Session end time must be after start time',
      );
    const overlapping = await this.prisma.ptSession.findFirst({
      where: {
        organizationId,
        OR: [
          { memberId: dto.memberId },
          ...(dto.trainerId ? [{ trainerId: dto.trainerId }] : []),
        ],
        // Any branch: a trainer or member cannot be in two places at once,
        // and matching on this branch only let a trainer be booked at two
        // branches for the same hour.
        status: { in: ['SCHEDULED', 'COMPLETED'] },
        AND: [
          { startTime: { lt: dto.endTime } },
          { endTime: { gt: dto.startTime } },
        ],
      },
    });
    if (overlapping)
      throw new BadRequestException(
        'Time conflicts with an existing session for member, trainer, or branch',
      );
    // The same trainer can also be booked through an appointment.
    if (dto.trainerId)
      await this.assertTrainerFreeAcrossCalendar(
        organizationId,
        dto.trainerId,
        new Date(dto.startTime),
        new Date(dto.endTime),
      );
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.ptSession.create({
        data: {
          organizationId,
          memberId: dto.memberId,
          trainerId: dto.trainerId ?? null,
          branchId: dto.branchId,
          startTime: new Date(dto.startTime),
          endTime: new Date(dto.endTime),
          type: dto.type,
          price: dto.price,
          notes: dto.notes,
        },
      });
      const payload: PtSessionBookedEvent = {
        organizationId,
        ptSessionId: session.id,
        memberId: session.memberId,
        trainerId: session.trainerId ?? undefined,
        branchId: session.branchId,
        startTime: session.startTime,
        endTime: session.endTime,
        bookedByUserId,
      };
      this.events.emit(DomainEvent.PtSessionBooked, payload);
      return session;
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdatePtSessionDto,
    updatedByUserId: string,
    assignmentScope: string | null = null,
  ) {
    const session = await this.getOne(organizationId, id);
    await this.assertSessionWithinAssignment(
      organizationId,
      assignmentScope,
      session,
    );
    await this.assertWithinAssignment(
      organizationId,
      assignmentScope,
      dto.memberId,
      dto.trainerId,
    );
    if (
      session.status !== 'SCHEDULED' &&
      dto.status === undefined &&
      (!dto.notes || dto.notes === session.notes)
    )
      throw new BadRequestException(
        `Cannot update session with status ${session.status}`,
      );
    const startTime = dto.startTime ?? session.startTime;
    const endTime = dto.endTime ?? session.endTime;
    if (startTime >= endTime)
      throw new BadRequestException(
        'Session end time must be after start time',
      );
    if (dto.memberId)
      await this.assertMemberBelongsToOrg(organizationId, dto.memberId);
    if (dto.trainerId !== undefined)
      await this.assertTrainerBelongsToOrg(organizationId, dto.trainerId);
    if (dto.branchId)
      await this.assertBranchBelongsToOrg(organizationId, dto.branchId);
    const memberId = dto.memberId ?? session.memberId;
    const trainerId = dto.trainerId ?? session.trainerId;
    if (
      dto.startTime !== undefined ||
      dto.endTime !== undefined ||
      dto.memberId !== undefined ||
      dto.trainerId !== undefined ||
      dto.branchId !== undefined
    ) {
      const overlapping = await this.prisma.ptSession.findFirst({
        where: {
          organizationId,
          id: { not: id },
          OR: [{ memberId }, ...(trainerId ? [{ trainerId }] : [])],
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          AND: [{ startTime: { lt: endTime } }, { endTime: { gt: startTime } }],
        },
      });
      if (overlapping)
        throw new BadRequestException(
          'Updated time conflicts with an existing session for member, trainer, or branch',
        );
      if (trainerId)
        await this.assertTrainerFreeAcrossCalendar(
          organizationId,
          trainerId,
          new Date(startTime),
          new Date(endTime),
          id,
        );
    }
    return this.prisma.$transaction(async (tx) => {
      const updatedSession = await tx.ptSession.update({
        where: { id },
        data: {
          ...(dto.memberId !== undefined ? { memberId: dto.memberId } : {}),
          ...(dto.trainerId !== undefined ? { trainerId: dto.trainerId } : {}),
          ...(dto.branchId !== undefined ? { branchId: dto.branchId } : {}),
          ...(dto.startTime !== undefined
            ? { startTime: new Date(dto.startTime) }
            : {}),
          ...(dto.endTime !== undefined
            ? { endTime: new Date(dto.endTime) }
            : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.isPaid !== undefined ? { isPaid: dto.isPaid } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              memberCode: true,
            },
          },
          trainer: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          branch: { select: { id: true, name: true } },
        },
      });
      if (dto.status && dto.status !== session.status) {
        switch (dto.status) {
          case 'COMPLETED': {
            await this.ptPackagesService.consumeForCompletedSession(
              tx,
              organizationId,
              updatedSession.id,
              updatedSession.memberId,
              updatedSession.startTime,
            );
            const payload: PtSessionCompletedEvent = {
              organizationId,
              ptSessionId: updatedSession.id,
              memberId: updatedSession.memberId,
              trainerId: updatedSession.trainerId ?? undefined,
              branchId: updatedSession.branchId,
              completedByUserId: updatedByUserId,
              actualEndTime: updatedSession.endTime,
            };
            this.events.emit(DomainEvent.PtSessionCompleted, payload);
            break;
          }
          case 'CANCELLED': {
            const payload: PtSessionCancelledEvent = {
              organizationId,
              ptSessionId: updatedSession.id,
              memberId: updatedSession.memberId,
              trainerId: updatedSession.trainerId ?? undefined,
              branchId: updatedSession.branchId,
              cancelledByUserId: updatedByUserId,
              cancellationReason: dto.notes,
            };
            this.events.emit(DomainEvent.PtSessionCancelled, payload);
            break;
          }
          case 'NO_SHOW': {
            const payload: PtSessionCancelledEvent = {
              organizationId,
              ptSessionId: updatedSession.id,
              memberId: updatedSession.memberId,
              trainerId: updatedSession.trainerId ?? undefined,
              branchId: updatedSession.branchId,
              cancelledByUserId: updatedByUserId,
              cancellationReason: 'No show',
            };
            this.events.emit(DomainEvent.PtSessionCancelled, payload);
            break;
          }
        }
      }
      return updatedSession;
    });
  }

  async complete(
    organizationId: string,
    id: string,
    completedByUserId: string,
    assignmentScope: string | null = null,
  ) {
    return this.update(
      organizationId,
      id,
      { status: 'COMPLETED', completedByUserId },
      completedByUserId,
      assignmentScope,
    );
  }
  async cancel(
    organizationId: string,
    id: string,
    cancelledByUserId: string,
    cancellationReason?: string,
    assignmentScope: string | null = null,
  ) {
    return this.update(
      organizationId,
      id,
      { status: 'CANCELLED', cancelledByUserId, notes: cancellationReason },
      cancelledByUserId,
      assignmentScope,
    );
  }
  async markNoShow(
    organizationId: string,
    id: string,
    markedByUserId: string,
    assignmentScope: string | null = null,
  ) {
    return this.update(
      organizationId,
      id,
      { status: 'NO_SHOW' },
      markedByUserId,
      assignmentScope,
    );
  }
}
