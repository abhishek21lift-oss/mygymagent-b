import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import type {
  BulkAssignMembershipDto,
  BulkExportDto,
  BulkStatusChangeDto,
  BulkTagAssignmentDto,
} from './dto/member-bulk.dto';

const MS_PER_DAY = 86_400_000;

/** Why a selected member is not getting a membership from this run. */
export type BulkMembershipSkipReason =
  'alreadyHasActiveMembership' | 'outsideYourScope' | 'branchMismatch';

export interface BulkAssignMembershipReport {
  dryRun: boolean;
  plan: {
    id: string;
    name: string;
    durationDays: number;
    price: string;
    currency: string;
  };
  startDate: string;
  endDate: string;
  requested: number;
  toCreate: number;
  created: number;
  skipped: Record<BulkMembershipSkipReason, number>;
  /** Named, not just counted -- a number alone cannot be acted on. */
  skippedMembers: Array<{
    memberId: string;
    memberCode: string;
    name: string;
    reason: BulkMembershipSkipReason;
  }>;
  /** What the run is worth if applied, at the plan's price. */
  totalValue: string;
}

function escapeCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Bulk member operations from the directory's selection bar. Status
 * changes reuse the same status-history write MembersService.update()
 * performs per-row, so bulk edits never create history gaps. Export
 * returns CSV text (the only format the directory UI parses today --
 * `format: xlsx` is accepted but served as CSV; requesting anything
 * else is a 400, never a silent wrong-format file).
 */
@Injectable()
export class MemberBulkService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Give every selected member the same membership.
   *
   * `dryRun` is the point of this method, not a flag bolted onto it: the
   * caller is about to create hundreds of billable rows from data that
   * never carried a plan, so the report has to be readable *before*
   * anything is written -- including which members are being passed over
   * and why, by name, because a count of skips is not something anyone
   * can act on.
   *
   * A member already holding an ACTIVE or FROZEN membership is skipped
   * rather than given a second overlapping one. That is the failure this
   * whole method is one bad click away from, and it is the expensive
   * direction: two live memberships on one person means two expiry
   * dates, two renewal reminders and a double charge downstream.
   */
  async assignMemberships(
    organizationId: string,
    dto: BulkAssignMembershipDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ): Promise<BulkAssignMembershipReport> {
    if (dto.memberIds.length === 0)
      throw new BadRequestException('memberIds must not be empty');
    if (dto.memberIds.length > 500)
      throw new BadRequestException(
        'Bulk membership assignment is limited to 500 members at a time',
      );

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: dto.membershipPlanId, organizationId, isActive: true },
    });
    if (!plan)
      throw new NotFoundException('Membership plan not found or inactive');

    const startDate = dto.startDate ? new Date(dto.startDate) : new Date();
    if (Number.isNaN(startDate.getTime()))
      throw new BadRequestException('startDate is not a valid date');
    const endDate = new Date(
      startDate.getTime() + plan.durationDays * MS_PER_DAY,
    );

    // Everything the caller asked for that they are actually allowed to
    // see. Anything missing from this set is out of scope, and is
    // reported as such rather than silently dropped.
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        id: { in: dto.memberIds },
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        primaryBranchId: true,
        memberships: {
          where: { status: { in: ['ACTIVE', 'FROZEN'] } },
          select: { id: true },
          take: 1,
        },
      },
    });
    const found = new Map(members.map((m) => [m.id, m]));

    const skipped: Record<BulkMembershipSkipReason, number> = {
      alreadyHasActiveMembership: 0,
      outsideYourScope: 0,
      branchMismatch: 0,
    };
    const skippedMembers: BulkAssignMembershipReport['skippedMembers'] = [];
    const eligible: Array<{ id: string; branchId: string }> = [];

    for (const memberId of dto.memberIds) {
      const member = found.get(memberId);
      if (!member) {
        skipped.outsideYourScope += 1;
        skippedMembers.push({
          memberId,
          memberCode: '',
          name: '',
          reason: 'outsideYourScope',
        });
        continue;
      }
      const name = `${member.firstName} ${member.lastName}`.trim();
      if (member.memberships.length > 0) {
        skipped.alreadyHasActiveMembership += 1;
        skippedMembers.push({
          memberId,
          memberCode: member.memberCode,
          name,
          reason: 'alreadyHasActiveMembership',
        });
        continue;
      }
      // A plan pinned to one branch cannot be sold to a member who
      // belongs to another; an org-wide plan follows the member.
      const branchId = plan.branchId ?? member.primaryBranchId;
      if (plan.branchId && plan.branchId !== member.primaryBranchId) {
        skipped.branchMismatch += 1;
        skippedMembers.push({
          memberId,
          memberCode: member.memberCode,
          name,
          reason: 'branchMismatch',
        });
        continue;
      }
      eligible.push({ id: member.id, branchId });
    }

    const report: BulkAssignMembershipReport = {
      dryRun: dto.dryRun ?? false,
      plan: {
        id: plan.id,
        name: plan.name,
        durationDays: plan.durationDays,
        price: plan.price.toFixed(2),
        currency: plan.currency,
      },
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      requested: dto.memberIds.length,
      toCreate: eligible.length,
      created: 0,
      skipped,
      skippedMembers,
      totalValue: plan.price.mul(eligible.length).toFixed(2),
    };

    if (report.dryRun || eligible.length === 0) return report;

    // createMany, so 291 rows are one statement and one transaction --
    // either the whole run lands or none of it does. No payments are
    // written: see the DTO comment.
    const result = await this.prisma.membership.createMany({
      data: eligible.map((m) => ({
        organizationId,
        branchId: m.branchId,
        memberId: m.id,
        membershipPlanId: plan.id,
        status: 'ACTIVE' as const,
        startDate,
        endDate,
        price: new Prisma.Decimal(plan.price),
        currency: plan.currency,
        autoRenew: dto.autoRenew ?? false,
      })),
    });
    report.created = result.count;
    return report;
  }

  async changeStatus(
    organizationId: string,
    dto: BulkStatusChangeDto,
    changedByUserId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    if (dto.memberIds.length === 0)
      throw new BadRequestException('memberIds must not be empty');
    if (dto.memberIds.length > 500)
      throw new BadRequestException(
        'Bulk status change is limited to 500 members at a time',
      );

    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        id: { in: dto.memberIds },
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      select: { id: true, status: true },
    });
    if (members.length !== dto.memberIds.length)
      throw new NotFoundException(
        'One or more members were not found in your scope',
      );

    const changed = members.filter((m) => m.status !== dto.status);
    await this.prisma.$transaction(async (tx) => {
      await tx.member.updateMany({
        where: { id: { in: changed.map((m) => m.id) } },
        data: { status: dto.status },
      });
      if (changed.length > 0) {
        await tx.memberStatusHistory.createMany({
          data: changed.map((m) => ({
            organizationId,
            memberId: m.id,
            fromStatus: m.status,
            toStatus: dto.status,
            changedByUserId,
          })),
        });
      }
    });
    return { updated: changed.length };
  }

  async assignTags(
    organizationId: string,
    dto: BulkTagAssignmentDto,
    assignedByUserId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    if (dto.memberIds.length === 0 || dto.tagIds.length === 0)
      throw new BadRequestException('memberIds and tagIds must not be empty');
    if (dto.memberIds.length > 500)
      throw new BadRequestException(
        'Bulk tag assignment is limited to 500 members at a time',
      );

    const [members, tags] = await Promise.all([
      this.prisma.member.findMany({
        where: {
          organizationId,
          id: { in: dto.memberIds },
          deletedAt: null,
          ...(branchScope ? { primaryBranchId: branchScope } : {}),
          ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
        },
        select: { id: true },
      }),
      this.prisma.memberTag.findMany({
        where: { organizationId, id: { in: dto.tagIds } },
        select: { id: true },
      }),
    ]);
    if (members.length !== dto.memberIds.length)
      throw new NotFoundException(
        'One or more members were not found in your scope',
      );
    if (tags.length !== dto.tagIds.length)
      throw new NotFoundException('One or more tags were not found');

    let assigned = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const memberId of dto.memberIds) {
        for (const tagId of dto.tagIds) {
          const existing = await tx.memberTagAssignment.findUnique({
            where: { memberId_tagId: { memberId, tagId } },
            select: { id: true },
          });
          if (!existing) {
            await tx.memberTagAssignment.create({
              data: { organizationId, memberId, tagId, assignedByUserId },
            });
            assigned += 1;
          }
        }
      }
    });
    return { assigned };
  }

  async export(
    organizationId: string,
    dto: BulkExportDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ): Promise<string> {
    if (dto.format && dto.format !== 'csv')
      throw new BadRequestException(
        'Only CSV export is supported; xlsx is not available',
      );
    if (dto.memberIds.length === 0)
      throw new BadRequestException('memberIds must not be empty');
    if (dto.memberIds.length > 2000)
      throw new BadRequestException(
        'Export is limited to 2000 members at a time',
      );

    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        id: { in: dto.memberIds },
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      include: {
        primaryBranch: { select: { name: true } },
        assignedTrainer: { select: { firstName: true, lastName: true } },
        tagAssignments: { include: { tag: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const headers = [
      'memberCode',
      'firstName',
      'lastName',
      'email',
      'phone',
      'status',
      'memberType',
      'branch',
      'trainer',
      'joinedAt',
      'tags',
    ];
    const lines = [
      headers.join(','),
      ...members.map((m) =>
        [
          m.memberCode,
          m.firstName,
          m.lastName,
          m.email ?? '',
          m.phone ?? '',
          m.status,
          m.memberType ?? '',
          m.primaryBranch.name,
          m.assignedTrainer
            ? `${m.assignedTrainer.firstName} ${m.assignedTrainer.lastName}`
            : '',
          m.joinedAt.toISOString(),
          m.tagAssignments.map((a) => a.tag.name).join('; '),
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ];
    return lines.join('\n');
  }
}
