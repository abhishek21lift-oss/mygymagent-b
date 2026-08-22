# analytics

**Status: Revenue & Finance (P1) built and tested; Member/Sales/Trainer/Inventory intelligence (P2) not started.**

## What exists

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

## What's explicitly not computed, and why

Every response includes a `notComputable` array naming exactly what's missing and why, so a caller
(a future dashboard, an AI tool) never mistakes "not tracked" for "zero":

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

## What's still not started (P2 scope)

Member/Revenue/Sales/Trainer-PT/Inventory *intelligence* (trends, forecasts, churn risk, trainer
performance, low-stock forecasting) — the master prompt lists these explicitly as P2, after the
operational foundation (this phase). This module currently answers "what happened" (real,
period-scoped totals), not "what's likely to happen" or "who's at risk" — that's the P2 work.

## Tested

`test/analytics-revenue.e2e-spec.ts` — real Postgres: gross/membership/other revenue split
correctly for a mix of membership and one-off payments, refunds netted correctly, multi-currency
payments kept in separate buckets rather than summed together, and the outstanding-balance figure
matching a short-paid membership.
