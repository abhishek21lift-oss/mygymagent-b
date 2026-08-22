# analytics

**Status: Revenue & Finance (P1) and Member/Sales/Trainer/Inventory intelligence (P2) built and tested.**

## Revenue & Finance (P1)

`FinanceService.getRevenueSummary()` — the "centralized financial intelligence layer" the master
prompt asks for, exposed via `GET /analytics/revenue` (`?from=&to=`, both optional ISO dates,
defaulting to the current UTC calendar month; branch-scoped the same way every other list endpoint
in this codebase is, via `@CurrentBranchScope()`). Guarded by `reports.view` (already seeded —
`BRANCH_MANAGER`/`HEAD_TRAINER`/`ACCOUNTANT`/`ORG_OWNER`/`ORG_ADMIN` hold it).

Computed from real `Payment`/`Refund`/`Membership` rows, **per currency** — `Payment.currency` and
`Membership.currency` are per-record fields, not fixed per organization, so summing across
currencies would silently produce a meaningless number. The response is an array with one entry
per currency actually seen in the period, not a single flat total.

Per currency:
- **grossRevenue** — every payment in the period (a payment's `amount` is always the original
  charge, never mutated by a later refund — see the `Payment` model comment — so this is exactly
  what was charged, refunded or not).
- **membershipRevenue** — the subset of gross revenue linked to a `Membership` (sign-ups/renewals).
- **otherRevenue** — `grossRevenue - membershipRevenue`. Deliberately not split further into PT vs.
  product vs. anything else — see "What's explicitly not computed" below for why that split isn't
  possible.
- **refunded** / **netRevenue** — refunds recorded in the period, and gross minus those.
- **outstanding** — a snapshot (not scoped to the period): the same "membership.price minus net
  real payments" computation `PaymentOverdueScanner` uses (`src/automation/`), aggregated into a
  per-currency total across every ACTIVE/PENDING membership with a shortfall, rather than
  per-membership reminders.

`FinanceService.getRevenueTrend()` — `GET /analytics/revenue/trend?months=` (1–24, default 6): the
same gross/refunded/net figures as above, one entry per UTC calendar month, oldest first — the
series a growth chart needs. A separate, leaner query than calling `getRevenueSummary()` in a loop
would be: it doesn't repeat the (period-independent) outstanding-balance snapshot or the
`notComputable` array for every month.

### What's explicitly not computed, and why

Every `getRevenueSummary()` response includes a `notComputable` array naming exactly what's
missing and why, so a caller (a dashboard, the `get_revenue_summary` AI tool) never mistakes "not
tracked" for "zero":

- **Product revenue** — `StockMovement` records quantity only, not price, and has no link to a
  `Payment`. There's no way to know if or when a product sale was paid for, or at what price.
- **PT revenue** — no PT session/package data model exists (same gap `src/automation/README.md`
  flags for PT-expiry reminders). A `Payment` with no `membershipId` could be a PT session, a
  product, or anything else — nothing distinguishes which.
- **Discounts** — `Payment`/`Membership` record price net; nothing records what was waived.
- **Expenses, payroll** — no models exist for either.
- **Commissions** — `StaffProfile.commissionRate` exists, but no `Payment` or `Membership` records
  which staff member a given payment should count toward — the rate has nothing to apply it to.

None of these are approximated or guessed at. Building any of them means adding the underlying
data model first (a PT-session model, a discount field, an expense/payroll table, a
payment-to-staff attribution) — real decisions this module doesn't make on its own.

## Member/Sales/Trainer/Inventory intelligence (P2)

"What's likely to happen" on top of P1's "what happened" — every figure is explainable (traces
back to real rows a human could re-derive by hand), not a black-box score or a forecast built on
data that doesn't exist.

- **`MemberIntelligenceService.getAtRiskMembers()`** — `GET /analytics/members/at-risk`: currently
  ACTIVE members with no `Attendance` in 14+ days (or none ever), ranked most-at-risk first. A
  deliberately earlier/lower threshold than `MemberInactiveScanner`'s 30-day automation trigger
  (`src/automation/`) — a "watch list" staff can act on before the automated recovery email even
  fires, not a duplicate of it.
- **`MemberIntelligenceService.getStatusBreakdown()`** — `GET /analytics/members/status-breakdown`:
  member counts grouped by `MemberStatus`.
- **`SalesIntelligenceService.getFunnel()`** — `GET /analytics/sales/funnel?from=&to=` (both
  optional; omitted means all-time, unlike revenue's "this month" default — a funnel is naturally
  read cumulatively): lead counts by status, conversion rate, average days from lead creation to a
  `WON` conversion, and follow-up completion rate.
- **`TrainerIntelligenceService.getWorkload()`** — `GET /analytics/trainers/workload`: per trainer
  (`StaffProfile.isTrainer`), currently-assigned member count and workout/diet plans assigned in
  the last 30 days. Also returns its own `notComputable` — PT session utilization, PT revenue per
  trainer, and commission earned are all blocked on the same missing PT-session model and
  payment-to-staff attribution the Revenue & Finance section above already documents.
- **`InventoryIntelligenceService.getStockForecast()`** — `GET /analytics/inventory/forecast`:
  every active product's current stock, whether it's at/below `reorderLevel`, its daily sales rate
  computed from real `StockMovement` `SALE` history over the last 30 days, and an estimated
  days-until-stockout (`null`, not a guess, when there's no recent sales history to forecast
  from). Sorted soonest-to-stock-out first, with no-forecast products sorting last.

## AI tool exposure

All five intelligence services above (plus `FinanceService`) are also reachable through
`POST /ai/chat` as typed, permission-aware tools (`get_revenue_summary`, `get_at_risk_members`,
`get_sales_funnel`, `get_trainer_workload`, `get_inventory_forecast` — see `src/ai/README.md` and
`src/ai/tools/tool-executor.service.ts`). Each calls the exact same service this module's own REST
controller does, and is gated on `reports.view` via the tool executor's `resolveAccess()` — the
same permission the REST endpoints require, so a caller who can't see `GET /analytics/revenue`
can't reach `get_revenue_summary` through the assistant either. This is the P2 "AI Agent
Architecture evolution" work: typed tools wired to real domain services, reusing the P0
permission-resolution pattern rather than a new one. A full Supervisor/specialist-agent
orchestration layer is P3 ("Gym Brain") scope, not built here — introducing multi-agent
orchestration with nothing yet requiring it would be exactly the "flashy AI UI before the
operational foundation" the master prompt says not to build first.

## Tested

- `test/analytics-revenue.e2e-spec.ts` — gross/membership/other revenue split correctly for a mix
  of membership and one-off payments, refunds netted correctly, multi-currency payments kept in
  separate buckets rather than summed together, and the outstanding-balance figure matching a
  short-paid membership.
- `test/analytics-intelligence.e2e-spec.ts` — at-risk detection (and correct exclusion of a
  recently-active member), member status breakdown, a full sales funnel (conversion rate,
  time-to-conversion, follow-up completion), trainer workload with its `notComputable` PT
  disclosure, stock-forecast ranking (a fast-moving product sorting before one with no sales
  history), and the revenue trend series length/ordering.
- `test/ai.e2e-spec.ts` — the 5 intelligence tools reachable via the tool executor and returning
  real data (not stubs), and rejected for a caller without `reports.view` the same way
  `create_followup` is rejected for a caller without `leads.manage`.
