import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import {
  DomainEvent,
  type AttendanceRecordedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CheckInDto } from './dto/check-in.dto';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    filters: {
      branchId?: string;
      memberId?: string;
      assignmentScope?: string | null;
    },
  ) {
    const where = {
      organizationId,
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.memberId ? { memberId: filters.memberId } : {}),
      ...(filters.assignmentScope
        ? { member: { assignedTrainerId: filters.assignmentScope } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where,
        ...skipTake(query),
        orderBy: { checkInAt: query.order ?? 'desc' },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              assignedTrainerId: true,
            },
          },
          staffUser: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.attendance.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async checkIn(
    organizationId: string,
    recordedByUserId: string,
    dto: CheckInDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    if (branchScope && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot check in a member/staff to a branch outside your assignment',
      );
    }
    if (!dto.memberId && !dto.staffUserId) {
      throw new BadRequestException(
        'Either memberId or staffUserId is required',
      );
    }
    if (dto.memberId && dto.staffUserId) {
      throw new BadRequestException(
        'Provide only one of memberId or staffUserId',
      );
    }

    if (dto.memberId) {
      const member = await this.prisma.member.findFirst({
        where: {
          id: dto.memberId,
          organizationId,
          deletedAt: null,
          ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
        },
      });
      if (!member) throw new NotFoundException('Member not found');
    } else if (dto.staffUserId) {
      if (assignmentScope) {
        throw new BadRequestException(
          'Assigned trainers can only record attendance for their assigned members',
        );
      }
      const staff = await this.prisma.user.findFirst({
        where: { id: dto.staffUserId, organizationId, deletedAt: null },
      });
      if (!staff) throw new NotFoundException('Staff user not found');
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, organizationId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const record = await this.prisma.attendance.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        memberId: dto.memberId,
        staffUserId: dto.staffUserId,
        method: dto.method ?? 'MANUAL',
        recordedByUserId,
      },
    });
    const payload: AttendanceRecordedEvent = {
      organizationId,
      branchId: record.branchId,
      attendanceId: record.id,
      memberId: record.memberId ?? undefined,
      staffUserId: record.staffUserId ?? undefined,
    };
    this.events.emit(DomainEvent.AttendanceRecorded, payload);
    return record;
  }

  async checkOut(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const record = await this.prisma.attendance.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(assignmentScope
          ? { member: { assignedTrainerId: assignmentScope } }
          : {}),
      },
    });
    if (!record) throw new NotFoundException('Attendance record not found');
    if (record.checkOutAt) throw new BadRequestException('Already checked out');
    return this.prisma.attendance.update({
      where: { id },
      data: { checkOutAt: new Date() },
    });
  }
}
