import { Injectable } from '@nestjs/common';
import { AiActionsService } from '../ai-actions/ai-actions.service';
import {
  FinanceService,
  type RevenueSummary,
} from '../analytics/finance.service';
import {
  InventoryIntelligenceService,
  type StockForecast,
} from '../analytics/inventory-intelligence.service';
import {
  MemberIntelligenceService,
  currentTermWhere,
  type AtRiskMember,
} from '../analytics/member-intelligence.service';
import {
  SalesIntelligenceService,
  type SalesFunnel,
} from '../analytics/sales-intelligence.service';
import {
  TrainerIntelligenceService,
  type TrainerWorkload,
} from '../analytics/trainer-intelligence.service';
import {
  organizationTimezone,
  startOfZonedDay,
  startOfZonedMonth,
  zonedDate,
  zonedMidnight,
} from '../common/time/zoned';
import { RENEWAL_FOLLOW_UP_PREFIX } from '../portal/portal.service';
import { PrismaService } from '../prisma/prisma.service';

const TOP_N = 5;
const EXPIRING_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DailyBriefing {
  generatedAt: string;
  branchId: string | null;
  today: {
    /// Members admitted since the gym's local midnight. Denied attempts
    /// (a row with `deniedReason`) and staff check-ins are attendance
    /// rows too, but neither is a member visit.
    checkIns: number;
    /// Members turned away at the door today -- the front desk's cue.
    deniedCheckIns: number;
  };
  revenue: RevenueSummary;
  atRiskMembers: {
    count: number;
    /// Most-at-risk first, capped at TOP_N -- the full list is already
    /// available via GET /analytics/members/at-risk (or the
    /// get_at_risk_members tool) for anyone who needs every row.
    top: AtRiskMember[];
  };
  salesFunnel: SalesFunnel;
  lowStock: {
    count: number;
    top: StockForecast[];
  };
  trainerWorkload: {
    trainerCount: number;
    top: TrainerWorkload[];
    notComputable: { key: string; reason: string }[];
  };
  pendingAiActions: number;
  /// Lead follow-ups still open and due by the end of the gym's today,
  /// whenever their lead came in. `salesFunnel.followUps` is a different
  /// thing -- every follow-up, done or not, on leads created this month
  /// -- and the dashboard used to present that as "due".
  followUpsDue: {
    count: number;
    overdue: number;
  };
  /// Memberships whose running term ends within EXPIRING_WINDOW_DAYS and
  /// has not been renewed -- the renewal calls to make this week. A
  /// renewal links back to the term it follows; a cancelled one leaves
  /// the term expiring again.
  expiringSoon: { count: number; withinDays: number };
  /// Open member follow-ups due by the end of the gym's today, most
  /// overdue first. A renewal request from the member app is one of
  /// these, and until now it showed only on that member's own page --
  /// nobody saw it unless they happened to open that member.
  memberFollowUpsDue: {
    count: number;
    overdue: number;
    renewalRequests: number;
    top: MemberFollowUpDue[];
  };
}

export interface MemberFollowUpDue {
  id: string;
  memberId: string;
  firstName: string;
  lastName: string;
  title: string;
  dueAt: string | null;
  isRenewalRequest: boolean;
}

/**
 * The Owner Daily Briefing (P3): a single real, computed report over
 * data P1/P2 already made queryable one endpoint at a time
 * (`src/analytics/`) plus P3's own Action Center backlog -- not a new
 * data source, and not an AI-generated summary of numbers that don't
 * exist elsewhere. Every field here traces back to the same service a
 * standalone `GET /analytics/*` route already calls; this module's only
 * job is aggregation, so a caller who wants "what does today look like"
 * doesn't have to make six requests and rebuild the picture themselves.
 * See `get_daily_briefing` in `src/ai/tools/` for the assistant-facing
 * side of the same aggregation.
 */
@Injectable()
export class DailyBriefingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly memberIntelligence: MemberIntelligenceService,
    private readonly salesIntelligence: SalesIntelligenceService,
    private readonly trainerIntelligence: TrainerIntelligenceService,
    private readonly inventoryIntelligence: InventoryIntelligenceService,
    private readonly aiActions: AiActionsService,
  ) {}

  async getDailyBriefing(
    organizationId: string,
    branchScope: string | null,
  ): Promise<DailyBriefing> {
    const now = new Date();
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const startOfToday = startOfZonedDay(now, timezone);
    const today = zonedDate(now, timezone);
    const startOfTomorrow = zonedMidnight(
      today.year,
      today.month,
      today.day + 1,
      timezone,
    );
    const memberVisitToday = {
      organizationId,
      memberId: { not: null },
      checkInAt: { gte: startOfToday },
      ...(branchScope ? { branchId: branchScope } : {}),
    };
    const openFollowUp = {
      organizationId,
      completedAt: null,
      lead: {
        status: { notIn: ['WON' as const, 'LOST' as const] },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
    };
    const memberFollowUpDue = {
      organizationId,
      completedAt: null,
      dueAt: { lt: startOfTomorrow },
      member: {
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
    };
    const monthStart = startOfZonedMonth(now, timezone);

    const [
      checkIns,
      deniedCheckIns,
      followUpsDue,
      followUpsOverdue,
      expiringSoon,
      revenue,
      atRiskMembers,
      salesFunnel,
      stockForecast,
      trainerWorkload,
      pendingAiActions,
      memberFollowUps,
      memberFollowUpsOverdue,
      renewalRequests,
      memberFollowUpsTop,
    ] = await Promise.all([
      this.prisma.attendance.count({
        where: { ...memberVisitToday, deniedReason: null },
      }),
      this.prisma.attendance.count({
        where: { ...memberVisitToday, deniedReason: { not: null } },
      }),
      this.prisma.leadFollowUp.count({
        where: { ...openFollowUp, dueAt: { lt: startOfTomorrow } },
      }),
      this.prisma.leadFollowUp.count({
        where: { ...openFollowUp, dueAt: { lt: startOfToday } },
      }),
      this.prisma.membership.count({
        where: {
          organizationId,
          ...currentTermWhere(now),
          endDate: {
            gte: now,
            lte: new Date(now.getTime() + EXPIRING_WINDOW_DAYS * MS_PER_DAY),
          },
          OR: [
            { nextMembership: { is: null } },
            { nextMembership: { is: { status: 'CANCELLED' } } },
          ],
          member: {
            deletedAt: null,
            ...(branchScope ? { primaryBranchId: branchScope } : {}),
          },
        },
      }),
      this.finance.getRevenueSummary(organizationId, {}, branchScope, timezone),
      this.memberIntelligence.getAtRiskMembers(organizationId, branchScope),
      this.salesIntelligence.getFunnel(organizationId, branchScope, {
        from: monthStart.toISOString(),
      }),
      this.inventoryIntelligence.getStockForecast(organizationId, branchScope),
      this.trainerIntelligence.getWorkload(organizationId, branchScope),
      this.aiActions.countPending(organizationId),
      this.prisma.memberFollowUp.count({ where: memberFollowUpDue }),
      this.prisma.memberFollowUp.count({
        where: { ...memberFollowUpDue, dueAt: { lt: startOfToday } },
      }),
      this.prisma.memberFollowUp.count({
        where: {
          ...memberFollowUpDue,
          title: { startsWith: RENEWAL_FOLLOW_UP_PREFIX },
        },
      }),
      this.prisma.memberFollowUp.findMany({
        where: memberFollowUpDue,
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
        take: TOP_N,
        select: {
          id: true,
          memberId: true,
          title: true,
          dueAt: true,
          member: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    const lowStock = stockForecast.filter((p) => p.atOrBelowReorderLevel);

    return {
      generatedAt: now.toISOString(),
      branchId: branchScope,
      today: { checkIns, deniedCheckIns },
      revenue,
      atRiskMembers: {
        count: atRiskMembers.length,
        top: atRiskMembers.slice(0, TOP_N),
      },
      salesFunnel,
      lowStock: {
        count: lowStock.length,
        top: lowStock.slice(0, TOP_N),
      },
      trainerWorkload: {
        trainerCount: trainerWorkload.trainers.length,
        top: trainerWorkload.trainers.slice(0, TOP_N),
        notComputable: trainerWorkload.notComputable,
      },
      pendingAiActions,
      followUpsDue: { count: followUpsDue, overdue: followUpsOverdue },
      expiringSoon: {
        count: expiringSoon,
        withinDays: EXPIRING_WINDOW_DAYS,
      },
      memberFollowUpsDue: {
        count: memberFollowUps,
        overdue: memberFollowUpsOverdue,
        renewalRequests,
        top: memberFollowUpsTop.map((f) => ({
          id: f.id,
          memberId: f.memberId,
          firstName: f.member.firstName,
          lastName: f.member.lastName,
          title: f.title,
          dueAt: f.dueAt?.toISOString() ?? null,
          isRenewalRequest: f.title.startsWith(RENEWAL_FOLLOW_UP_PREFIX),
        })),
      },
    };
  }
}
