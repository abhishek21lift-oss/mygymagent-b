import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  SegmentRule,
  evaluateRules,
  MemberSegmentResult,
} from './segment-rules';
import { MemberSegment } from '@prisma/client';

export interface CreateSegmentDto {
  name: string;
  description?: string;
  rules: SegmentRule[];
  isSystem?: boolean;
}

export interface UpdateSegmentDto {
  name?: string;
  description?: string;
  rules?: SegmentRule[];
}

const SYSTEM_SEGMENT_DEFINITIONS: {
  name: string;
  description: string;
  rules: SegmentRule[];
}[] = [
  {
    name: 'At Risk',
    description: 'Members with HIGH or CRITICAL risk level',
    rules: [
      { field: 'riskLevel', operator: 'in', value: ['HIGH', 'CRITICAL'] },
    ],
  },
  {
    name: 'Churning',
    description: 'Members at risk for churning',
    rules: [
      { field: 'riskLevel', operator: 'in', value: ['HIGH', 'CRITICAL'] },
      { field: 'daysSinceLastVisit', operator: 'lte', value: 30 },
    ],
  },
  {
    name: 'Champions',
    description: 'Long-term, active members with LOW risk',
    rules: [
      { field: 'riskLevel', operator: 'eq', value: 'LOW' },
      { field: 'daysSinceJoining', operator: 'gte', value: 365 },
    ],
  },
  {
    name: 'Renewal This Month',
    description: 'Members with membership expiring within 30 days',
    rules: [
      { field: 'daysUntilExpiry', operator: 'gte', value: 0 },
      { field: 'daysUntilExpiry', operator: 'lte', value: 30 },
    ],
  },
  {
    name: 'New Members',
    description: 'Members who joined within the last 90 days',
    rules: [{ field: 'daysSinceJoining', operator: 'lte', value: 90 }],
  },
  {
    name: 'Lapsed',
    description: 'No attendance in the last 30 days',
    rules: [{ field: 'daysSinceLastVisit', operator: 'gt', value: 30 }],
  },
];

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureSystemSegments(organizationId: string): Promise<void> {
    for (const def of SYSTEM_SEGMENT_DEFINITIONS) {
      const existing = await this.prisma.memberSegment.findFirst({
        where: { organizationId, name: def.name, isSystem: true },
      });

      if (!existing) {
        await this.prisma.memberSegment.create({
          data: {
            organizationId,
            name: def.name,
            description: def.description,
            rules: def.rules as any,
            isSystem: true,
          },
        });
      }
    }
  }

  async createSegment(
    organizationId: string,
    userId: string,
    dto: CreateSegmentDto,
  ): Promise<MemberSegment> {
    return this.prisma.memberSegment.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        rules: dto.rules as any,
        isSystem: dto.isSystem ?? false,
        createdByUserId: userId,
      },
    });
  }

  async listSegments(
    organizationId: string,
  ): Promise<{ segment: MemberSegment; memberCount: number }[]> {
    await this.ensureSystemSegments(organizationId);

    const segments = await this.prisma.memberSegment.findMany({
      where: { organizationId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    const results: { segment: MemberSegment; memberCount: number }[] = [];

    for (const seg of segments) {
      const memberCount = await this.countSegmentMembers(
        organizationId,
        seg.id,
      );
      results.push({ segment: seg, memberCount });
    }

    return results;
  }

  async getSegment(
    organizationId: string,
    segmentId: string,
  ): Promise<MemberSegment | null> {
    return this.prisma.memberSegment.findFirst({
      where: { id: segmentId, organizationId },
    });
  }

  async updateSegment(
    organizationId: string,
    segmentId: string,
    dto: UpdateSegmentDto,
  ): Promise<MemberSegment> {
    const segment = await this.prisma.memberSegment.findFirst({
      where: { id: segmentId, organizationId },
    });

    if (!segment) {
      throw new NotFoundException(`Segment ${segmentId} not found`);
    }

    if (segment.isSystem) {
      throw new ForbiddenException('System segments cannot be modified');
    }

    return this.prisma.memberSegment.update({
      where: { id: segmentId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.rules && { rules: dto.rules as any }),
      },
    });
  }

  async deleteSegment(
    organizationId: string,
    segmentId: string,
  ): Promise<void> {
    const segment = await this.prisma.memberSegment.findFirst({
      where: { id: segmentId, organizationId },
    });

    if (!segment) {
      throw new NotFoundException(`Segment ${segmentId} not found`);
    }

    if (segment.isSystem) {
      throw new ForbiddenException('System segments cannot be deleted');
    }

    await this.prisma.memberSegmentAssignment.deleteMany({
      where: { segmentId },
    });

    await this.prisma.memberSegment.delete({
      where: { id: segmentId },
    });
  }

  async getSegmentMembers(
    organizationId: string,
    segmentId: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<MemberSegmentResult[]> {
    const segment = await this.prisma.memberSegment.findFirst({
      where: { id: segmentId, organizationId },
    });

    if (!segment) {
      throw new NotFoundException(`Segment ${segmentId} not found`);
    }

    const rules = segment.rules as unknown as SegmentRule[];
    const members = await this.resolveSegmentMembers(
      organizationId,
      rules,
      limit,
      offset,
    );

    return members.map((m) => ({
      memberId: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      status: m.status,
      riskLevel: m.riskProfile?.riskLevel ?? null,
    }));
  }

  async countSegmentMembers(
    organizationId: string,
    segmentId: string,
  ): Promise<number> {
    const segment = await this.prisma.memberSegment.findFirst({
      where: { id: segmentId, organizationId },
    });

    if (!segment) return 0;

    const rules = segment.rules as unknown as SegmentRule[];
    const allMembers = await this.resolveSegmentMembers(
      organizationId,
      rules,
      10000,
      0,
    );

    return allMembers.length;
  }

  private async resolveSegmentMembers(
    organizationId: string,
    rules: SegmentRule[],
    limit: number,
    offset: number,
  ): Promise<any[]> {
    if (rules.length === 0) {
      return this.prisma.member.findMany({
        where: { organizationId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          status: true,
          joinedAt: true,
          riskProfile: { select: { riskLevel: true } },
        },
        take: limit,
        skip: offset,
      });
    }

    const members = await this.prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      include: {
        riskProfile: { select: { riskLevel: true, overallScore: true } },
        memberships: {
          where: { status: { in: ['ACTIVE', 'PENDING'] } },
          select: { endDate: true, status: true },
          take: 1,
          orderBy: { endDate: 'desc' },
        },
        attendances: {
          orderBy: { checkInAt: 'desc' },
          select: { checkInAt: true },
          take: 1,
        },
        goals: {
          where: { status: 'ACTIVE' },
          select: { id: true },
        },
      },
      take: 10000,
    });

    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const enrichedMembers = members.map((m) => {
      const lastVisit = m.attendances[0]?.checkInAt;
      const daysSinceLastVisit = lastVisit
        ? Math.floor((now - lastVisit.getTime()) / MS_PER_DAY)
        : Math.floor((now - m.joinedAt.getTime()) / MS_PER_DAY);

      const daysSinceJoining = Math.floor(
        (now - m.joinedAt.getTime()) / MS_PER_DAY,
      );
      const daysUntilExpiry = m.memberships[0]?.endDate
        ? Math.floor((m.memberships[0].endDate.getTime() - now) / MS_PER_DAY)
        : 999;

      return {
        ...m,
        daysSinceLastVisit,
        daysSinceJoining,
        daysUntilExpiry,
        hasGoals: m.goals.length > 0,
        hasTrainer: m.assignedTrainerId !== null,
        totalPayments: 0,
        attendanceLast30Days: 0,
      };
    });

    const filtered = enrichedMembers.filter((m) => evaluateRules(m, rules));

    return filtered.slice(offset, offset + limit);
  }
}
