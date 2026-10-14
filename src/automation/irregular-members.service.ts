import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappProfileService } from './whatsapp-profile.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_RANGE_DAYS = 1;
const MAX_RANGE_DAYS = 90;

export interface IrregularMember {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  lastCheckInAt: string | null;
  daysInactive: number;
  /** Subscription state today: ACTIVE, a lapsed INACTIVE, or NONE. */
  subscriptionStatus: 'ACTIVE' | 'INACTIVE' | 'NONE';
  membershipEndDate: string | null;
}

export interface IrregularMembersReport {
  thresholdDays: number;
  generatedAt: string;
  members: IrregularMember[];
}

/**
 * The Irregular Members preview: members whose last visit is at least
 * `rangeDays` ago (or the gym's saved threshold when no range is given).
 *
 * Read-only by design -- the Control Center shows the list and the count
 * without notifying anyone. Opening the page must never send a message;
 * only the scheduled MEMBER_INACTIVE_RECOVERY scan sends, and only inside
 * its own window. Scoped by the caller's organizationId, never a
 * client-supplied one.
 */
@Injectable()
export class IrregularMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WhatsappProfileService,
  ) {}

  async list(
    organizationId: string,
    rangeDaysRaw?: string | number | null,
    now: Date = new Date(),
  ): Promise<IrregularMembersReport> {
    const thresholdDays = await this.resolveRange(organizationId, rangeDaysRaw);

    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        OR: [{ email: { not: null } }, { phone: { not: null } }],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        joinedAt: true,
        attendances: {
          orderBy: { checkInAt: 'desc' },
          take: 1,
          select: { checkInAt: true },
        },
        memberships: {
          orderBy: { endDate: 'desc' },
          take: 1,
          select: { status: true, endDate: true },
        },
      },
    });

    const rows: IrregularMember[] = [];
    for (const member of members) {
      const lastActivity = member.attendances[0]?.checkInAt ?? member.joinedAt;
      const daysInactive = Math.floor(
        (now.getTime() - lastActivity.getTime()) / MS_PER_DAY,
      );
      if (daysInactive < thresholdDays) continue;
      const membership = member.memberships[0] ?? null;
      rows.push({
        id: member.id,
        name: [member.firstName, member.lastName]
          .filter(Boolean)
          .join(' ')
          .trim(),
        phone: member.phone,
        email: member.email,
        lastCheckInAt: member.attendances[0]?.checkInAt.toISOString() ?? null,
        daysInactive,
        subscriptionStatus: !membership
          ? 'NONE'
          : membership.status === 'ACTIVE' &&
              membership.endDate.getTime() >= now.getTime()
            ? 'ACTIVE'
            : 'INACTIVE',
        membershipEndDate: membership?.endDate.toISOString() ?? null,
      });
    }

    // Longest absence first: the members most at risk of being lost.
    rows.sort((a, b) => b.daysInactive - a.daysInactive);

    return {
      thresholdDays,
      generatedAt: now.toISOString(),
      members: rows,
    };
  }

  /** An explicit range is the UI's Last 3/7/15/30 or Custom control;
   * absent, the gym's saved irregular threshold applies. */
  private async resolveRange(
    organizationId: string,
    rangeDaysRaw?: string | number | null,
  ): Promise<number> {
    if (
      rangeDaysRaw === undefined ||
      rangeDaysRaw === null ||
      rangeDaysRaw === ''
    ) {
      return this.profiles.irregularThreshold(organizationId);
    }
    const days = Number(rangeDaysRaw);
    if (
      !Number.isInteger(days) ||
      days < MIN_RANGE_DAYS ||
      days > MAX_RANGE_DAYS
    ) {
      throw new BadRequestException(
        `rangeDays must be an integer ${MIN_RANGE_DAYS}..${MAX_RANGE_DAYS}`,
      );
    }
    return days;
  }
}
