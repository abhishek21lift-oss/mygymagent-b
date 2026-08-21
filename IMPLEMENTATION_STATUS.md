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
| Communication (real provider abstraction: email/WhatsApp/SMS/push, templates, retries, delivery status, consent, audit) | ⬜ | Requires provider credentials (SendGrid/Twilio/WhatsApp Business API or equivalent) — see `ARCHITECTURE_DECISIONS.md` for the stop-and-ask on this |
| Scheduler + Jobs infrastructure | ⬜ | |
| Event Engine (tenant-aware domain events) | ⬜ | 10 events already defined in `src/events/domain-events.ts`; 9 have no listener |
| Automation Engine (Trigger → Conditions → Action → Approval → Execute → Audit) | ⬜ | |
| Revenue & Finance intelligence layer | ⬜ | |

## P2 — Intelligence

⬜ Not started (Member/Revenue/Sales/Trainer/Inventory intelligence, AI Agent architecture evolution).

## P3 — Gym Brain

⬜ Not started.

## How this file is maintained

Updated at the end of every phase that changes what's built. Each row's evidence column should
name real files and real tests, not aspirations — matching the discipline the pre-existing module
READMEs already use in this codebase (state what's built, what's not, and why).
