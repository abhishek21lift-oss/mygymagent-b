import { Injectable } from '@nestjs/common';
import { effectiveMemberStatus } from '../analytics/member-intelligence.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappProfileService } from './whatsapp-profile.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_ROWS = 200;

export type IrregularSubscriptionStatus = 'ACTIVE' | 'INACTIVE' | 'NONE';

export interface IrregularMemberRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  lastCheckInAt: string | null;
  daysInactive: number;
  subscriptionStatus: IrregularSubscriptionStatus;
  membershipEndDate: string | null;
}

/**
 * Who the MEMBER_INACTIVE_RECOVERY schedule would re-engage, and why.
 *
 * Read-only on purpose: opening the preview never messages anyone. Every
 * read is scoped by organizationId (plus the caller's branch scope), so
 * one gym's lapsed members never leak into another's report. Follows the
 * same attendance/membership patterns as the win-back candidates query
 * (member-intelligence.service.ts).
 */
@Injectable()
export class IrregularMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WhatsappProfileService,
  ) {}

  async getReport(
    organizationId: string,
    rangeDays: number | undefined,
    branchScope: string | null,
  ): Promise<{
    thresholdDays: number;
    generatedAt: string;
    members: IrregularMemberRow[];
  }> {
    const profile = await this.profiles.get(organizationId);
    const threshold = rangeDays ?? profile.irregularThresholdDays;
    const now = new Date();

    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      take: MAX_ROWS,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
        memberships: {
          select: { status: true, startDate: true, endDate: true },
        },
      },
    });

    const visits = await this.prisma.attendance.groupBy({
      by: ['memberId'],
      where: { organizationId, deniedReason: null },
      _max: { checkInAt: true },
    });
    const lastCheckInByMember = new Map(
      visits.map((v) => [v.memberId, v._max.checkInAt]),
    );

    const rows: IrregularMemberRow[] = [];
    for (const member of members) {
      const lastCheckInAt = lastCheckInByMember.get(member.id) ?? null;
      // Never checked in: count from joining, so a dormant sign-up still
      // surfaces instead of hiding behind a null.
      const since = lastCheckInAt ?? member.createdAt;
      const daysInactive = Math.floor(
        (now.getTime() - since.getTime()) / MS_PER_DAY,
      );
      if (daysInactive < threshold) continue;

      const effective = effectiveMemberStatus(
        { status: member.status, memberships: member.memberships },
        now,
      );
      const ends = member.memberships.map((t) => t.endDate.getTime());
      rows.push({
        id: member.id,
        name: `${member.firstName} ${member.lastName}`,
        phone: member.phone,
        email: member.email,
        lastCheckInAt: lastCheckInAt?.toISOString() ?? null,
        daysInactive,
        subscriptionStatus:
          effective === 'ACTIVE'
            ? 'ACTIVE'
            : effective === 'NO_MEMBERSHIP'
              ? 'NONE'
              : 'INACTIVE',
        membershipEndDate:
          ends.length > 0 ? new Date(Math.max(...ends)).toISOString() : null,
      });
    }

    rows.sort((a, b) => b.daysInactive - a.daysInactive);
    return {
      thresholdDays: threshold,
      generatedAt: now.toISOString(),
      members: rows,
    };
  }
}
