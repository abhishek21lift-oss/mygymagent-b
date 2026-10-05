# KPI Registry — Gym Health & Intelligence

One definition per metric. Every frontend surface must read the
**source** column, never recompute. Last verified: Phase 1 (2026-10-06).

## Gym Health Score (`GET /analytics/gym-health`, `reports.view`)

Deterministic 0–100, weight-renormalized over available components.
Null = "unknown", never 0. Formula lives in
`src/gym-health/gym-health.score.ts` (`computeHealthScore`).

| Component | Weight | Source endpoint | Formula | Scope | Refresh |
|---|---|---|---|---|---|
| Revenue | 30 | `/analytics/revenue` (month-to-date) | `net / gross × 100`, null when gross = 0 | org + branch | live/query |
| Collections | 25 | same (outstanding snapshot) | `100 − outstanding / (gross + outstanding) × 100`, null when nothing moved | org + branch | live/query |
| Retention | 20 | `/analytics/members/at-risk` + status breakdown | `100 − atRisk / active × 100`, null when no active | org + branch | live/query |
| Sales | 15 | `/analytics/sales/funnel` | `conversionRatePct`, null when no leads | org + branch | live/query |
| Inventory | 10 | `/analytics/inventory/forecast` | `100 − lowStock / total × 100`, null when no products | org + branch | live/query |

Status bands: ≥80 healthy, ≥60 stable, ≥40 needs-attention, else
critical. Opportunity = lowest available component. Response also
embeds `revenueAtRisk` (see below) so the dashboard needs one request.

## Revenue at Risk (`GET /analytics/revenue-at-risk`, `reports.view`)

| Metric | Source | Formula | Scope |
|---|---|---|---|
| atRiskMRR | ACTIVE/PENDING `Membership.price` over HIGH+CRITICAL members | sum (note: MRR ≈ price, not duration-normalized) | org + branch |
| atRiskPercentage | same | `atRiskMRR / totalMRR × 100` (0 when empty) | org + branch |
| bySegment | same grouped by risk level | HIGH/CRITICAL/MEDIUM/LOW mrr + memberCount | org + branch |

## Reused (owned elsewhere, referenced — do NOT duplicate)

| Metric | Owner endpoint | Used by |
|---|---|---|
| Net/gross/refunded/outstanding | `GET /analytics/revenue` (`FinanceService`) | finance KPIs, health inputs |
| At-risk list (14d, paying) | `GET /analytics/members/at-risk` | priorities, health input |
| Funnel + conversion | `GET /analytics/sales/*` | intelligence page, health input |
| Stock forecast + days-to-stockout | `GET /analytics/inventory/forecast` | inventory, health input |
| Today check-ins/denied | `GET /briefing/daily` | Today KPIs |
| Pending AI actions | `AiActionsService.countPending` via briefing | hero badge, priorities |
| Expiring (7d, renewal-aware) | briefing `expiringSoon` / lifecycle 30d | priorities |
| Follow-ups due/overdue | briefing | priorities |
| Churn probability/indicators | `GET /analytics/members/:id/churn-assessment`, risk-overview/trend | intelligence + member pages |
| Recommendations + lifecycle | `RecommendedAction` via member endpoints | member panels |
| AI proposals + lifecycle | `GET /ai-actions` (PENDING→APPROVED→EXECUTED/FAILED/REJECTED) | action center |
| AI usage (24h req/cost/tokens) | platform command-center snapshot | platform ops only |

## Deliberately NOT computed (shown as — / omitted)

PT revenue per trainer, commission earned, discount impact, payroll,
expenses-in-score, ML predictions — no source model or link exists.
The analytics README's `notComputable` list is authoritative.
