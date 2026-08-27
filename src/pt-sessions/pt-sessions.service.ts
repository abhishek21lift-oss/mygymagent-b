import {
  BadRequestException,
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
import { PrismaService } from '../prisma/prisma.service';
import type { BookPtSessionDto } from './dto/book-pt-session.dto';
import type { UpdatePtSessionDto } from './dto/update-pt-session.dto';
import { MembersService } from '../members/members.service';
import { StaffProfilesService } from '../staff-profiles/staff-profiles.service';
import { BranchesService } from '../branches/branches.service';

@Injectable()
export class PtSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly membersService: MembersService,
    private readonly staffProfilesService: StaffProfilesService,
    private readonly branchesService: BranchesService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    memberId?: string,
    trainerId?: string,
    branchId?: string,
    startFrom?: Date,
    endTo?: Date,
  ) {
    const where: Prisma.PtSessionWhereInput = {
      organizationId,
      ...(memberId ? { memberId } : {}),
      ...(trainerId ? { trainerId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(startFrom && endTo
        ? {
            AND: [
              { startTime: { gte: startFrom } },
              { endTime: { lte: endTo } },
            ],
          }
        : {}),
      ...(startFrom && !endTo ? { startTime: { gte: startFrom } } : {}),
      ...(!startFrom && endTo ? { endTime: { lte: endTo } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.ptSession.findMany({
        where,
        ...skipTake(query),
        orderBy: { startTime: query.order ?? 'desc' },
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true, memberCode: true },
          },
          trainer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          branch: {
            select: { id: true, name: true },
          },
        },
      }),
      this.prisma.ptSession.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(
    organizationId: string,
    id: string,
  ) {
    const session = await this.prisma.ptSession.findFirst({
      where: { id, organizationId },
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, memberCode: true },
        },
        trainer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        branch: {
          select: { id: true, name: true },
        },
      },
    });
    if (!session) throw new NotFoundException('PT session not found');
    return session;
  }

  private async assertMemberBelongsToOrg(
    organizationId: string,
    memberId: string,
  ): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!member) {
      throw new BadRequestException('Member not found in this organization');
    }
  }

  private async assertTrainerBelongsToOrg(
    organizationId: string,
    trainerId: string,
  ): Promise<void> {
    if (!trainerId) return;
    const trainer = await this.prisma.staffProfile.findFirst({
      where: { id: trainerId, organizationId },
    });
    if (!trainer) {
      throw new BadRequestException('Trainer not found in this organization');
    }
  }

  private async assertBranchBelongsToOrg(
    organizationId: string,
    branchId: string,
  ): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId },
    });
    if (!branch) {
      throw new BadRequestException('Branch not found in this organization');
    }
  }

  async book(
    organizationId: string,
    dto: BookPtSessionDto,
    bookedByUserId: string,
  ) {
    // Validate that referenced entities belong to this organization
    await this.assertMemberBelongsToOrg(organizationId, dto.memberId);
    if (dto.trainerId) {
      await this.assertTrainerBelongsToOrg(organizationId, dto.trainerId);
    }
    await this.assertBranchBelongsToOrg(organizationId, dto.branchId);

    // Validate session time
    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException('Session end time must be after start time');
    }

    // Check for overlapping sessions for the member/trainer/branch
    const overlapping = await this.prisma.ptSession.findFirst({
      where: {
        organizationId,
        OR: [
          { memberId: dto.memberId },
          ...(dto.trainerId ? [{ trainerId: dto.trainerId }] : []),
        ],
        branchId: dto.branchId,
        status: { in: ['SCHEDULED', 'COMPLETED'] },
        AND: [
          { startTime: { lt: dto.endTime } },
          { endTime: { gt: dto.startTime } },
        ],
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        'Time conflicts with an existing session for member, trainer, or branch',
      );
    }

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
          bookedByUserId,
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
  ) {
    const session = await this.getOne(organizationId, id);

    // Don't allow updates to completed/cancelled/no-show sessions except notes
    if (
      session.status !== 'SCHEDULED' &&
      dto.status === undefined &&
      (!dto.notes || dto.notes === session.notes)
    ) {
      throw new BadRequestException(
        `Cannot update session with status ${session.status}`,
      );
    }

    // Validate time updates if provided
    const startTime = dto.startTime ?? session.startTime;
    const endTime = dto.endTime ?? session.endTime;
    if (startTime >= endTime) {
      throw new BadRequestException('Session end time must be after start time');
    }

    // Validate that referenced entities belong to this organization
    if (dto.memberId) {
      await this.assertMemberBelongsToOrg(organizationId, dto.memberId);
    }
    if (dto.trainerId !== undefined) {
      await this.assertTrainerBelongsToOrg(organizationId, dto.trainerId);
    }
    if (dto.branchId) {
      await this.assertBranchBelongsToOrg(organizationId, dto.branchId);
    }

    // Check for overlapping sessions if time or key identifiers changed
    const memberId = dto.memberId ?? session.memberId;
    const trainerId = dto.trainerId ?? session.trainerId;
    const branchId = dto.branchId ?? session.branchId;

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
          OR: [
            { memberId: memberId },
            ...(trainerId ? [{ trainerId: trainerId }] : []),
          ],
          branchId: branchId,
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          AND: [
            { startTime: { lt: endTime } },
            { endTime: { gt: startTime } },
          ],
        },
      });

      if (overlapping) {
        throw new BadRequestException(
          'Updated time conflicts with an existing session for member, trainer, or branch',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedSession = await tx.ptSession.update({
        where: { id },
        data: {
          ...(dto.memberId !== undefined ? { memberId: dto.memberId } : {}),
          ...(dto.trainerId !== undefined ? { trainerId: dto.trainerId } : {}),
          ...(dto.branchId !== undefined ? { branchId: dto.branchId } : {}),
          ...(dto.startTime !== undefined ? { startTime: new Date(dto.startTime) } : {}),
          ...(dto.endTime !== undefined ? { endTime: new Date(dto.endTime) } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.isPaid !== undefined ? { isPaid: dto.isPaid } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedByUserId,
        },
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true, memberCode: true },
          },
          trainer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          branch: {
            select: { id: true, name: true },
          },
        },
      });

      // Emit domain events for status changes
      if (dto.status && dto.status !== session.status) {
        switch (dto.status) {
          case 'COMPLETED': {
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
  ) {
    return this.update(organizationId, id, {
      status: 'COMPLETED',
      completedByUserId,
    }, completedByUserId);
  }

  async cancel(
    organizationId: string,
    id: string,
    cancelledByUserId: string,
    cancellationReason?: string,
  ) {
    return this.update(organizationId, id, {
      status: 'CANCELLED',
      cancelledByUserId,
      notes: cancellationReason,
    }, cancelledByUserId);
  }

  async markNoShow(
    organizationId: string,
    id: string,
    markedByUserId: string,
  ) {
    return this.update(organizationId, id, {
      status: 'NO_SHOW',
    }, markedByUserId);
  }
}