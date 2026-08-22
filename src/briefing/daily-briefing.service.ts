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
import { PrismaService } from '../prisma/prisma.service';

const TOP_N = 5;

export interface DailyBriefing {
  generatedAt: string;
  branchId: string | null;
  today: {
    /// UTC calendar day -- a check-in at 11pm and one at 1am the next
    /// day fall in different days, same boundary every other UTC-based
    /// window in this codebase (FinanceService's month, the 30-day
    /// windows) already uses.
    checkIns: number;
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
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const [
      checkIns,
      revenue,
      atRiskMembers,
      salesFunnel,
      stockForecast,
      trainerWorkload,
      pendingAiActions,
    ] = await Promise.all([
      this.prisma.attendance.count({
        where: {
          organizationId,
          checkInAt: { gte: startOfToday },
          ...(branchScope ? { branchId: branchScope } : {}),
        },
      }),
      this.finance.getRevenueSummary(organizationId, {}, branchScope),
      this.memberIntelligence.getAtRiskMembers(organizationId, branchScope),
      this.salesIntelligence.getFunnel(organizationId, branchScope, {
        from: monthStart.toISOString(),
      }),
      this.inventoryIntelligence.getStockForecast(organizationId),
      this.trainerIntelligence.getWorkload(organizationId, branchScope),
      this.aiActions.countPending(organizationId),
    ]);

    const lowStock = stockForecast.filter((p) => p.atOrBelowReorderLevel);

    return {
      generatedAt: now.toISOString(),
      branchId: branchScope,
      today: { checkIns },
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
    };
  }
}
