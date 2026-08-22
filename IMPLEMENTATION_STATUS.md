# MY GYM AGENT — Implementation Status

Tracks progress against the AI-transformation master prompt, whose source of truth is the
2026-08-21 forensic audit (`docs/architecture/discovery-report.md` and the published audit
artifact it summarizes). Updated at the end of every phase, not batched — see
`CHANGELOG_AI_TRANSFORMATION.md` for the dated, itemized log this file summarizes.

Status legend: ✅ done and verified · 🚧 in progress · ⬜ not started.

## P0 — Fix First

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Fix `/ai/chat` branch + trainer assignment authorization vulnerability | ✅ | `src/ai/tools/tool-executor.service.ts` (`resolveAccess()`), `src/ai/ai.controller.ts`, `src/ai/ai.service.ts`; regression tests in `test/ai.e2e-spec.ts` |
| 2 | Fix RBAC "DENY > ALLOW" precedence bug | ✅ | `src/rbac/permissions.service.ts`; unit tests in `src/rbac/permissions.service.spec.ts`, real-Postgres regression in `test/permission-override-precedence.e2e-spec.ts` |
| 3 | Fix inventory overselling concurrency race | ✅ | `src/inventory/stock-movements.service.ts`; regression test in `test/inventory.e2e-spec.ts` |
| 4 | Fix payment/refund concurrency race | ✅ | `src/billing/payments.service.ts`; regression test in `test/payments.e2e-spec.ts` |
| 5 | Correct the security test matrix | ✅ | `docs/security/overview.md` (matrix rewritten row-by-row against what each cited test actually proves), `docs/architecture/adr/0002-auth-token-strategy.md` (removed an unsupported reuse-detection claim) |

**P0 verification (2026-08-21):** typecheck clean, lint clean, 11/11 unit tests passing, 18/18 e2e
suites passing (113/113 tests, up from 107 — 6 new regression tests), all against real
Postgres/Redis/s3rver, not mocks. Committed and pushed to
`claude/gym-management-saas-platform-l0xmdh`.

**Known limitation carried forward, not a P0 item:** F-05 from the audit (assignment scoping is
Members-module-only — `/memberships/:id`, `/attendance`, `/workout-assignments` don't scope by
trainer assignment at the REST layer) is **not** fixed by P0 item 1. Item 1 fixed the *AI tool*
path specifically, per the master prompt's explicit P0 scope. The underlying REST-layer gap is
tracked as P1 work (Member 360 / assignment-scoping hardening). Documented honestly in the
corrected security test matrix rather than implied fixed.

## P1 — Operational Foundation

| Area | Status | Note |
|---|---|---|
| Communication — EMAIL | ✅ | Real SMTP delivery (`src/communications/`), templates (org-override + system-default), per-org branding, MARKETING-consent gating, `MessageLog` delivery/failure audit trail. User's explicit choice: build email now (no new paid signup — any SMTP relay/mailbox works), defer WhatsApp/SMS/push. |
| Communication — WhatsApp/SMS/Push | ⬜ | Typed provider interfaces exist (`src/communications/interfaces/`) with an `UnimplementedChannelProvider` that throws clearly rather than faking delivery — no real provider wired in, per the user's explicit deferral. Needs real credentials (Twilio/WhatsApp Business API/push provider) to implement. |
| Scheduler + Jobs infrastructure | ✅ | `src/automation/automation-scheduler.service.ts` — BullMQ `upsertJobScheduler` (idempotent daily repeatable jobs), reusing `QueueModule`'s existing retries/backoff/failure-tracking rather than a second scheduling abstraction |
| Event Engine (tenant-aware domain events) | 🚧 | `inventory.low` now has a real listener (`src/automation/inventory-low.listener.ts`); `membership.started`/`cancelled`, `payment.recorded`/`refunded`, `lead.converted`, etc. still unconsumed — the automations built don't need them (they're poll-based scans, not event-reactive) |
| Automation Engine (Trigger → Conditions → Action → Approval-if-required → Execute → Audit) | ✅ (5 of 6) | `src/automation/` — membership renewal, payment overdue, inactive-member recovery, lead follow-up, low-stock alert. PT expiry explicitly **not built**: no PT session/package data model exists to compute an expiry from — see `src/automation/README.md`. No approval step yet: every automation here is a notification send, so "Approval-if-required" is honestly "not required" at this risk tier — see that README for when that changes. |
| Revenue & Finance intelligence layer | ✅ | `src/analytics/finance.service.ts` — `GET /analytics/revenue`: gross/membership/other revenue, refunds, net, and outstanding balance, all computed per-currency from real Payment/Refund/Membership rows (never summed across currencies). Product revenue, PT revenue, discounts, expenses, payroll, commissions are explicitly flagged as not computable (with why) rather than approximated — see `src/analytics/README.md`. |

**Communication (EMAIL) verification (2026-08-21):** typecheck clean, lint clean, 11/11 unit tests
passing, 19/19 e2e suites passing (115/115 tests, up from 113 — 2 new: password-reset end-to-end
via a real local SMTP server, and the existing welcome-email queue test now exercising real SMTP
delivery instead of a stub). All against real Postgres/Redis/s3rver/SMTP, not mocks — see
`test/utils/smtp-capture-server.ts`. Also fixed two real bugs this uncovered (not test-only
artifacts): `SMTP_SECURE` used `z.coerce.boolean()`, which coerces the literal string `"false"` to
`true`; and a shutdown-ordering race where the shared Redis connection and Prisma both disconnected
before BullMQ's worker had a chance to finish an in-flight job, permanently hanging `app.close()`
whenever a job was still active at shutdown (previously masked by the old stub mailer completing
too fast to ever hit the race). See `ARCHITECTURE_DECISIONS.md` entries AI-6 through AI-8.

**Scheduler + Automation Engine verification (2026-08-21):** typecheck clean, lint clean, 11/11
unit tests passing, 20/20 e2e suites passing (122/122 tests, up from 115 — 7 new, in
`test/automation.e2e-spec.ts`), all against real Postgres/Redis/SMTP. Covers each scanner's real
trigger condition, its cooldown suppressing a repeat run, the payment-overdue balance computed
from real Payment/Refund rows, the MARKETING-consent-gated SKIPPED path, and the real-time
inventory-low event → queue → email path end to end.

**Revenue & Finance verification (2026-08-22):** typecheck clean, lint clean, 11/11 unit tests
passing, 21/21 e2e suites passing (126/126 tests, up from 122 — 4 new, in
`test/analytics-revenue.e2e-spec.ts`). Covers the membership/other revenue split, refunds netting
correctly, multi-currency payments staying in separate buckets rather than being summed, and the
outstanding-balance figure agreeing with a short-paid membership.

**P1 status: complete**, within what the master prompt's own rules allow honestly building —
WhatsApp/SMS/Push (deferred by explicit user choice, needs paid credentials), PT expiry (blocked,
no data model), and 9 of 10 domain events remaining unconsumed (not needed by what was built) are
documented gaps, not oversights. Every ✅ above has real code, a real test, and a real verification
run behind it.

## P2 — Intelligence

| Area | Status | Note |
|---|---|---|
| Member intelligence | ✅ | `src/analytics/member-intelligence.service.ts` — `GET /analytics/members/at-risk` (14-day no-attendance watch list), `GET /analytics/members/status-breakdown` |
| Revenue intelligence | ✅ | `FinanceService.getRevenueTrend()` — `GET /analytics/revenue/trend?months=`, per-currency monthly series on top of P1's per-period snapshot |
| Sales intelligence | ✅ | `src/analytics/sales-intelligence.service.ts` — `GET /analytics/sales/funnel`: conversion rate, time-to-conversion, follow-up completion rate |
| Trainer-PT intelligence | ✅ (workload only) | `src/analytics/trainer-intelligence.service.ts` — `GET /analytics/trainers/workload`: assigned-member count, recent plan-assignment activity. PT-specific metrics (session utilization, PT revenue, commission) explicitly flagged not computable — same PT-data-model gap as P1's PT expiry |
| Inventory intelligence | ✅ | `src/analytics/inventory-intelligence.service.ts` — `GET /analytics/inventory/forecast`: real stock-velocity forecasting (days-until-stockout) from actual `StockMovement` history |
| AI Agent architecture evolution | ✅ (typed tools, not full Supervisor) | 5 new typed, permission-aware AI tools (`get_revenue_summary`, `get_at_risk_members`, `get_sales_funnel`, `get_trainer_workload`, `get_inventory_forecast`) added to `src/ai/tools/`, each gated on `reports.view` via the P0 `resolveAccess()` pattern. A full multi-agent Supervisor/specialist-agent orchestration layer is explicitly deferred to P3 ("Gym Brain") — see `ARCHITECTURE_DECISIONS.md` AI-13 |

**P2 verification (2026-08-22):** typecheck clean, lint clean, 11/11 unit tests passing, 22/22 e2e
suites passing (139/139 tests, up from 126 — 13 new: 6 in `test/analytics-intelligence.e2e-spec.ts`,
7 added to `test/ai.e2e-spec.ts`). Also fixed a real class-validator bug found while adding the
first genuinely argument-less AI tool: `forbidUnknownValues` (a class-validator safety default)
rejects any DTO with zero validation decorators outright, which `EmptyArgsDto` is by design — fixed
in `validateToolArgs()`, safe for every existing DTO since none of them have zero decorators. See
`ARCHITECTURE_DECISIONS.md` AI-14.

**P2 status: complete**, within the same honesty discipline as P1 — PT-specific trainer metrics
remain blocked on the same missing PT-session data model P1 already flagged, not approximated.

## P3 — Gym Brain

| Area | Status | Note |
|---|---|---|
| Action Center (approval workflow) | ✅ | `src/ai-actions/` — READ→RECOMMEND→DRAFT→APPROVE→EXECUTE for the first genuinely consequential AI tools (`propose_assign_workout_plan`, `propose_assign_diet_plan`). `ai.approve` alone is not sufficient to approve: the approver's own resource permission (`workouts.assign`/`nutrition.assign`) is independently re-checked — see `ARCHITECTURE_DECISIONS.md` AI-15 |
| AI memory | ✅ | `src/ai/conversations/` — `AiConversation`/`AiMessage`, per-org-and-per-user scoped, soft-delete only per `docs/database/data-retention.md`. `POST /ai/chat` accepts `conversationId` to continue a real persisted conversation; `GET/DELETE /ai/conversations` for history management. See `ARCHITECTURE_DECISIONS.md` AI-16 |
| Owner Daily Briefing | ✅ | `src/briefing/` — `GET /briefing/daily` (and the `get_daily_briefing` AI tool) aggregate today's check-ins, this month's revenue, at-risk members, sales funnel, low-stock products, trainer workload, and pending Action Center proposals into one real, computed report — no new data source, every `notComputable` disclosure preserved |
| AI Supervisor / specialist agents | ⬜ (deliberate) | Still one tool-calling loop (14 tools); nothing built has ever needed routing between specialist toolsets. See `ARCHITECTURE_DECISIONS.md` AI-17 |
| Global AI command interface | ⬜ (deliberate, frontend) | Frontend-only concern; this session has worked exclusively in `mygymagent-b`. Backend already provides everything needed (`POST /ai/chat` + `GET /ai/conversations`). See `ARCHITECTURE_DECISIONS.md` AI-17 |

**Action Center + AI memory verification (2026-08-22):** typecheck clean, lint clean, 11/11 unit
tests passing, 24/24 e2e suites passing (151/151 tests, up from 139 — 12 new: 5 in
`test/ai-actions.e2e-spec.ts`, 7 in `test/ai-conversations.e2e-spec.ts`). All against real
Postgres/Redis/SMTP.

**Owner Daily Briefing verification (2026-08-22):** typecheck clean, lint clean, 11/11 unit tests
passing, 25/25 e2e suites passing (153/153 tests, up from 151 — 2 new, in
`test/daily-briefing.e2e-spec.ts`). Covers the aggregation reaching real seeded data (a check-in,
a low-stock product, a pending AI proposal) and the `reports.view` permission gate on both the
REST endpoint and the AI tool.

**P3 status: complete**, within the same honesty discipline P1/P2 established. The AI Supervisor/
specialist-agent layer and the global AI command interface are the two P3 master-prompt items not
built, both as deliberate, documented scope decisions rather than oversights — see
`ARCHITECTURE_DECISIONS.md` AI-17.

## How this file is maintained

Updated at the end of every phase that changes what's built. Each row's evidence column should
name real files and real tests, not aspirations — matching the discipline the pre-existing module
READMEs already use in this codebase (state what's built, what's not, and why).
