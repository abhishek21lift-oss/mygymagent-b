import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import { DomainEvent, type MemberCreatedEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMemberDto } from './dto/create-member.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    branchId?: string,
  ) {
    const where: Prisma.MemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(branchId ? { primaryBranchId: branchId } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
              { memberCode: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: { primaryBranch: { select: { id: true, name: true } } },
      }),
      this.prisma.member.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    const member = await this.prisma.member.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        primaryBranch: { select: { id: true, name: true } },
        assignedTrainer: {
          select: { id: true, firstName: true, lastName: true },
        },
        memberships: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { membershipPlan: true },
        },
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async create(organizationId: string, dto: CreateMemberDto) {
    const memberCode = await this.generateMemberCode(organizationId);
    const member = await this.prisma.member.create({
      data: {
        ...dto,
        organizationId,
        memberCode,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
    });
    const payload: MemberCreatedEvent = {
      organizationId,
      branchId: member.primaryBranchId,
      memberId: member.id,
    };
    this.events.emit(DomainEvent.MemberCreated, payload);
    return member;
  }

  async update(organizationId: string, id: string, dto: UpdateMemberDto) {
    await this.getOne(organizationId, id);
    return this.prisma.member.update({
      where: { id },
      data: {
        ...dto,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
    });
  }

  async remove(organizationId: string, id: string) {
    await this.getOne(organizationId, id);
    return this.prisma.member.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });
  }

  private async generateMemberCode(organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const count = await this.prisma.member.count({
        where: { organizationId },
      });
      const candidate = `M-${String(count + 1 + attempt).padStart(6, '0')}`;
      const collision = await this.prisma.member.findFirst({
        where: { organizationId, memberCode: candidate },
        select: { id: true },
      });
      if (!collision) return candidate;
    }
    return `M-${Date.now()}`;
  }
}
