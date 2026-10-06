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

## Phase 2 — Revenue + Retention OS (2026-10-06)

| Metric | Source endpoint | Formula | Scope |
|---|---|---|---|
| Renewal pipeline (upcoming ≤30d, overdue, high-value) | `GET /analytics/memberships/renewal-pipeline` (`MembershipLifecycleService`) | ACTIVE ending ≤30d ordered soonest; EXPIRED ≤30d ago with no ACTIVE successor; top-5 upcoming by price; capped 50 | org + branch |
| PT opportunities (expiring ≤14d w/ sessions left, never-started) | `GET /analytics/trainers/pt-opportunities` (`TrainerIntelligenceService`) | ACTIVE packages endDate ≤14d with remaining > 0; ACTIVE usedSessions = 0 started >14d ago; capped 50, honest counts | org + branch |
| Sales priority (hot/warm/watch + evidence) | `GET /analytics/sales/priority` (`SalesIntelligenceService`) | open leads (NEW/CONTACTED/QUALIFIED/TRIAL, latest 200): overdue follow-up → hot, due-today → hot, ≤3d fresh or qualified-unscheduled → warm, else watch; capped 25 | org + branch |
| Action outcomes (executed/rejected totals) | `GET /ai-actions?status=` (existing) | list totals; no date scope — labeled as all-time counts | org + `ai.approve` |

## Phase 3 — Retention OS (2026-10-06)

| Metric | Source endpoint | Formula | Scope |
|---|---|---|---|
| Win-back candidates + tiers | `GET /analytics/members/win-back` (`MemberIntelligenceService`) | EXPIRED status, last term ended >30d ago; value = COMPLETED payments sum; tiers = top 20% HIGH / next 30% MEDIUM by paid; capped 100 | org + branch |
| Renewal pipeline UI | existing Phase-2 endpoint (unchanged) | surfaced on /intelligence with upcoming/overdue/high-value | org + branch |
| Priority actions + outcomes | dashboard composes renewal/sales/PT/outstanding/risk/AI reads | deterministic rows with evidence + links; outcomes = ai-actions EXECUTED/REJECTED totals | per-row route perms |

## Phase 4 — PT OS (2026-10-06)

| Metric | Source endpoint | Formula | Scope |
|---|---|---|---|
| Session wallet (totals + ledger) | `GET /pt-packages/:id/wallet` (`PtPackagesService`) | counters from package row; scheduled/completed/cancelled/no-show = member sessions in package window; ledger = consumption table (idempotent unique) | org + branch |
| PT adherence (+streak) | `GET /analytics/pt-adherence?memberId` | completed/(completed+cancelled+no-show) 90d, null if <3 decided; workouts/visits 30d; weekly streak ≤12 | org + branch + assignment |
| Trainer delivery (completed, no-show %, completion %) | `GET /analytics/trainers/workload` (extended) | ptSession groupBy status 30d by StaffProfile id; completion null if <3 decided | org + branch |
| Session prep brief | `prepare_session_brief` AI tool | profile + active assignment + adherence + open follow-ups, scoped reads only | workouts.read + members.read |

## Phase 5 — Operations OS (2026-10-06)

| Metric | Source endpoint | Formula | Scope |
|---|---|---|---|
| Operations health (score + dimensions) | `GET /analytics/operations-health` | classes 30 (avg 7d utilization) + scheduling 25 (100 − 15×conflicts) + attendance 20 (admitted share today) + inventory 15 (healthy-stock share); weight-renormalized; tasks/SOP/equipment/facility/staff-score explicit nulls | org + branch |
| Class capacity (7d + 8-week demand) | `GET /analytics/classes/capacity` | booked = BOOKED+ATTENDED; util = booked/capacity (null when unset); bands 40/90/100+waitlist; demand = mean over sessions w/ capacity | org + branch |
| Scheduling conflicts | `GET /analytics/scheduling/conflicts` | instructor overlaps across classes/PT/appointments ≤7d (PT matched via StaffProfile→User); capped 20 | org + branch |
| Staff away today | embedded in operations-health | APPROVED leave covering today + names | org + branch |

## Phase 7 — AI COO (2026-10-06)

| Metric | Source endpoint | Formula | Scope |
|---|---|---|---|
| COO briefing (health + today + deltas + outcomes + spend) | `GET /analytics/coo-briefing` | gym-health + finance today/yesterday + gate counts + ai-actions counts + usage aggregate; day deltas null off zero | org + branch, `reports.view` |
| AI action outcomes (executed/rejected) | `AiActionsService.countOutcomes` | status counts; APPROVED transient, not an outcome | org |
| Tool governance | `AI_TOOL_POLICIES` registry | every allowlisted tool carries level/risk/approval/audit; mutating tools approved or audited by construction | n/a (static) |

## Phase 7 P1 — Maturity (2026-10-06)

| Metric | Source endpoint | Formula | Scope |
|---|---|---|---|
| Revenue/risk trends | `GET /analytics/coo-trends` | last 2 complete months net (org currency), % change null off zero; risk avg first vs last point | org + branch |
| Revenue forecast | `GET /analytics/coo-forecast` | moving avg + min-max band over ≤6 complete months; high ≥6 pts, moderate 3–5, insufficient <3 | org + branch |
| AI effectiveness | `GET /ai-actions/effectiveness` | acceptance = executed ÷ decided, execution = executed ÷ (approved + executed), null off zero | org, `ai.approve` |
| Renewal uplift scenario | frontend pure fn over renewal-pipeline | upcoming × uplift% × avg price, per currency; labeled hypothetical | client-side |
