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
import { PrismaService } from '../prisma/prisma.service';
import {
  EXPIRING_WINDOW_DAYS,
  TodayFiguresService,
  type DayFigures,
} from '../analytics/today-figures.service';

const TOP_N = 5;

export interface DailyBriefing {
  generatedAt: string;
  branchId: string | null;
  /// The gym's today, from TodayFiguresService: the same figures, by the
  /// same rules, as the dashboard's Today tiles, the COO page and the AI
  /// agent. `checkIns` counts members admitted at the door (denied
  /// attempts and staff check-ins are attendance rows too, but neither
  /// is a member visit); `deniedCheckIns` is the front desk's cue.
  today: DayFigures;
  /// Month to date, per currency (despite sitting next to `today`).
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
    private readonly todayFigures: TodayFiguresService,
  ) {}

  async getDailyBriefing(
    organizationId: string,
    branchScope: string | null,
  ): Promise<DailyBriefing> {
    const now = new Date();
    const timezone = await organizationTimezone(this.prisma, organizationId);
    const startOfToday = startOfZonedDay(now, timezone);
    const localDate = zonedDate(now, timezone);
    const startOfTomorrow = zonedMidnight(
      localDate.year,
      localDate.month,
      localDate.day + 1,
      timezone,
    );
    const openFollowUp = {
      organizationId,
      completedAt: null,
      lead: {
        status: { notIn: ['WON' as const, 'LOST' as const] },
        ...(branchScope ? { branchId: branchScope } : {}),
      },
    };
    const monthStart = startOfZonedMonth(now, timezone);

    const [
      today,
      followUpsDue,
      followUpsOverdue,
      expiringSoon,
      revenue,
      atRiskMembers,
      salesFunnel,
      stockForecast,
      trainerWorkload,
      pendingAiActions,
    ] = await Promise.all([
      this.todayFigures.forDay(organizationId, branchScope),
      this.prisma.leadFollowUp.count({
        where: { ...openFollowUp, dueAt: { lt: startOfTomorrow } },
      }),
      this.prisma.leadFollowUp.count({
        where: { ...openFollowUp, dueAt: { lt: startOfToday } },
      }),
      this.todayFigures.expiringSoon(organizationId, branchScope, now),
      this.finance.getRevenueSummary(organizationId, {}, branchScope),
      this.memberIntelligence.getAtRiskMembers(organizationId, branchScope),
      this.salesIntelligence.getFunnel(organizationId, branchScope, {
        from: monthStart.toISOString(),
      }),
      this.inventoryIntelligence.getStockForecast(organizationId, branchScope),
      this.trainerIntelligence.getWorkload(organizationId, branchScope),
      this.aiActions.countPending(organizationId),
    ]);

    const lowStock = stockForecast.filter((p) => p.atOrBelowReorderLevel);

    return {
      generatedAt: now.toISOString(),
      branchId: branchScope,
      today,
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
    };
  }
}
