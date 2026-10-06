/**
 * Gym Health Score inputs and result.
 *
 * Every component score is 0–100 derived from an existing analytics
 * service over real tenant rows, or null when there is no data to judge
 * (zero denominators must read as "unknown", never as 0 or 100). The
 * overall score is the weight-renormalized mean of the available
 * components, rounded to an integer.
 */
export interface HealthComponentInput {
  gross: number;
  net: number;
  outstanding: number;
  activeMembers: number;
  atRiskMembers: number;
  totalLeads: number;
  conversionRatePct: number;
  totalProducts: number;
  lowStockProducts: number;
}

export interface HealthComponent {
  key: 'revenue' | 'collections' | 'retention' | 'sales' | 'inventory';
  label: string;
  /** 0–100, or null when there is nothing to judge. */
  score: number | null;
  weight: number;
  /** Human-readable current value, e.g. "₹8.2L collected". */
  value: string;
  /** One line on what moved it. */
  explanation: string;
  /** Where the numbers came from. */
  source: string;
}

export interface GymHealth {
  /** 0–100, or null when no component has data. */
  score: number | null;
  status: 'healthy' | 'stable' | 'needs-attention' | 'critical' | 'unknown';
  /** Lowest-scoring available component key, for "biggest opportunity". */
  opportunity: HealthComponent['key'] | null;
  components: HealthComponent[];
  branchId: string | null;
  computedAt: string;
  /// True when rows carried more than one currency — ratios then blend
  /// denominations and the UI must say so instead of implying precision.
  mixedCurrencies: boolean;
}

const WEIGHTS: Record<HealthComponent['key'], number> = {
  revenue: 30,
  collections: 25,
  retention: 20,
  sales: 15,
  inventory: 10,
};

export function healthStatus(score: number | null): GymHealth['status'] {
  if (score === null) return 'unknown';
  if (score >= 80) return 'healthy';
  if (score >= 60) return 'stable';
  if (score >= 40) return 'needs-attention';
  return 'critical';
}

/**
 * Pure score computation — the only place gym-health math lives, so it is
 * unit-testable without a database.
 */
export function computeHealthScore(input: HealthComponentInput): {
  components: HealthComponent[];
  score: number | null;
  opportunity: GymHealth['opportunity'];
} {
  const revenue =
    input.gross > 0
      ? Math.max(0, Math.min(100, (input.net / input.gross) * 100))
      : null;
  const moved = input.gross + input.outstanding;
  const collections =
    moved > 0
      ? Math.max(0, Math.min(100, 100 - (input.outstanding / moved) * 100))
      : null;
  const retention =
    input.activeMembers > 0
      ? Math.max(
          0,
          Math.min(
            100,
            100 - (input.atRiskMembers / input.activeMembers) * 100,
          ),
        )
      : null;
  const sales =
    input.totalLeads > 0
      ? Math.max(0, Math.min(100, input.conversionRatePct))
      : null;
  const inventory =
    input.totalProducts > 0
      ? Math.max(
          0,
          Math.min(
            100,
            100 - (input.lowStockProducts / input.totalProducts) * 100,
          ),
        )
      : null;

  const components: HealthComponent[] = [
    {
      key: 'revenue',
      label: 'Revenue',
      score: revenue === null ? null : Math.round(revenue),
      weight: WEIGHTS.revenue,
      value: 'Net vs gross, month to date',
      explanation:
        revenue === null
          ? 'No collections recorded yet this month.'
          : 'Share of collected money kept after refunds.',
      source: 'GET /analytics/revenue',
    },
    {
      key: 'collections',
      label: 'Collections',
      score: collections === null ? null : Math.round(collections),
      weight: WEIGHTS.collections,
      value: 'Outstanding vs moved money',
      explanation:
        collections === null
          ? 'No money movement to judge.'
          : 'Share of moved money actually in hand.',
      source: 'GET /analytics/revenue (outstanding snapshot)',
    },
    {
      key: 'retention',
      label: 'Retention',
      score: retention === null ? null : Math.round(retention),
      weight: WEIGHTS.retention,
      value: `${input.atRiskMembers} of ${input.activeMembers} active at risk`,
      explanation:
        retention === null
          ? 'No active memberships to judge.'
          : 'Paying members with no visit in 14 days drag this down.',
      source: 'GET /analytics/members/at-risk + status breakdown',
    },
    {
      key: 'sales',
      label: 'Sales',
      score: sales === null ? null : Math.round(sales),
      weight: WEIGHTS.sales,
      value: `${input.totalLeads} leads in funnel`,
      explanation:
        sales === null
          ? 'No leads in the funnel yet.'
          : 'Lead-to-win conversion rate.',
      source: 'GET /analytics/sales/funnel',
    },
    {
      key: 'inventory',
      label: 'Inventory',
      score: inventory === null ? null : Math.round(inventory),
      weight: WEIGHTS.inventory,
      value: `${input.lowStockProducts} of ${input.totalProducts} low`,
      explanation:
        inventory === null
          ? 'No tracked products yet.'
          : 'Share of products with healthy stock levels.',
      source: 'GET /analytics/inventory/forecast',
    },
  ];

  const available = components.filter(
    (c): c is HealthComponent & { score: number } => c.score !== null,
  );
  if (available.length === 0) {
    return { components, score: null, opportunity: null };
  }
  const weightTotal = available.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round(
    available.reduce((sum, c) => sum + c.score * c.weight, 0) / weightTotal,
  );
  const opportunity = available.reduce((lowest, c) =>
    c.score < lowest.score ? c : lowest,
  ).key;
  return { components, score, opportunity };
}
