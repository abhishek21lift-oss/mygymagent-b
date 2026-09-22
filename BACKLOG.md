# MY GYM AGENT — Backend Fix Backlog

Source: full-system deep audit, 2026-09-22 (cross-checked `prisma/schema.prisma`, every
`src/` module, migration history through `20260923010000`, and `IMPLEMENTATION_STATUS.md` /
`CHANGELOG_AI_TRANSFORMATION.md` / `ARCHITECTURE_DECISIONS.md` / `AI_TASK_STATE.md` against
actual code). Companion to `mygymagent-f/BACKLOG.md` — items here are backend-only; cross-repo
items are cross-referenced by ID.

Priority legend: `P0` blocks calling this production-safe · `P1` blocks calling it feature-complete
· `P2` real gap, not urgent · `P3` polish/future.

Status legend: `⬜ not started` · `🚧 in progress` · `✅ done`.

---

## P0 — Architecture integrity & security (fix before adding anything else)

| # | Item | Status | Detail |
|---|---|---|---|
| B-P0-1 | Bring Business OS tables into Prisma | ⬜ | `src/business-os/business-os.service.ts` runs `$queryRawUnsafe`/`$executeRawUnsafe` against ~20 tables with **no Prisma model**: `loyalty_accounts`, `loyalty_ledger`, `referrals`, `support_tickets`, `support_ticket_messages`, `feedback_surveys`, `feedback_responses`, `marketing_campaigns`, `marketing_campaign_members`, `accounting_accounts`, `accounting_entries`, `portal_invites`, `kiosk_devices`, `kiosk_events`, `notification_devices`, `ai_command_logs`, `public_endpoint_rate_limits`, plus `trainer_commission_rules`, `trainer_commissions`, `payroll_periods`, `subscription_plans`, `organization_subscriptions`, `platform_invoices` (migrations `20260920120000_complete_business_os`, `20260923000000_remaining_business_os`, `20260923010000_business_os_public_rate_limits`). Add `model` blocks to `schema.prisma`, run `prisma migrate dev` to reconcile (no data-destructive changes — models only, tables already exist), then rewrite `business-os.service.ts` on the typed Prisma Client. Until this lands, `prisma validate`/schema-drift tooling cannot see this entire module. |
| B-P0-2 | e2e test coverage for untested modules | ⬜ | Zero e2e specs exist for: `business-os` (money-adjacent: double-entry accounting, trial balance, tax summary), `hr-payroll` (leave, payroll runs), `classes`/group training, notification center, WhatsApp send path. CI (`.github/workflows/ci.yml`) going green proves nothing about these. Write `test/business-os.e2e-spec.ts`, `test/hr-payroll.e2e-spec.ts`, `test/classes.e2e-spec.ts`, `test/notifications-center.e2e-spec.ts` following the existing real-Postgres/Redis pattern in `test/utils/test-app.ts`. |
| B-P0-3 | Verify and close F-05 (assignment-scoping outside Members) | ⬜ | `AI_TASK_STATE.md` (last updated 2026-08-25) claims membership/attendance/workout-assignment assignment-scoping was implemented but ends with unchecked `[ ] Full verification of membership/attendance remediation` and `[ ] Full verification of workout/AI remediation`. Confirm with a dedicated e2e suite (mirror `test/member-assignment-scoping.e2e-spec.ts`) that a trainer cannot read/act on an unassigned member's membership, attendance, or workout data over REST, then update the doc instead of leaving it half-checked. |
| B-P0-4 | MFA/2FA for staff accounts | ⬜ | Zero MFA implementation anywhere (`src/auth/`). Add TOTP-based 2FA at minimum for `OWNER`/`ADMIN`/`ACCOUNTANT` roles before this handles real payment/accounting data for paying gyms. |
| B-P0-5 | Reconcile duplicate check-in systems | ⬜ | `src/attendance/devices.controller.ts` (proper Prisma `DeviceMap`/`MemberQrToken` models) and business-os's raw-SQL `kiosk_devices`/`kiosk_events` are two independent, never-reconciled device check-in mechanisms. Decide which is canonical, migrate the other's data model into it (folds into B-P0-1), and remove the redundant path. |
| B-P0-6 | Reconcile duplicate payroll modules | ⬜ | `src/payroll/` and `src/hr-payroll/` both exist with overlapping responsibility (`PayrollRun`/`PayrollItem` vs `payroll_periods` raw table). Pick one, migrate the other's callers (frontend `use-staff.ts`/`payroll/page.tsx`), remove the loser. |

## P1 — Feature completeness

| # | Item | Status | Detail |
|---|---|---|---|
| B-P1-1 | Wire a real push provider (FCM) | ⬜ | `notification_devices` table (business-os) stores push tokens but nothing sends to them. Add an FCM `MessageProvider` implementation (`src/communications/providers/`), bind it, and route it through `CommunicationsService.send()` the same way SMTP does. Depends on B-P0-1 (needs a typed model first). See `mygymagent-f/BACKLOG.md` F-P1-1 for the client-side registration this unblocks. |
| B-P1-2 | Consume the remaining 9 domain events | ⬜ | `src/events/domain-events.ts` fires `membership.started/cancelled`, `payment.recorded/refunded`, `lead.converted`, `workout.assigned`, etc. — only `member.created` (`src/notifications/member-created.listener.ts`) has a listener. Add listeners for at least payment/membership/lead events so the notification center and automations become event-reactive, not just poll-based scanners. |
| B-P1-3 | Build the PT-expiry automation | ⬜ | Originally blocked (`ARCHITECTURE_DECISIONS.md` AI-10) on "no PT session/package data model." That model now exists (`PtPackage`, `PtSession`, `PtSessionConsumption`, migrations `20260829150000`/`20260829160000`). Revisit: add a `pt-expiry.scanner.ts` alongside the other 5 in `src/automation/scanners/`, now that the blocker is gone. |
| B-P1-4 | SMS provider wiring | ⬜ | `src/communications/interfaces/` has the typed abstraction; no Twilio (or equivalent) implementation. Needs paid credentials — confirm with the user before spending on this, but the interface is ready. |
| B-P1-5 | Reconcile all internal docs with actual current state | ⬜ | `IMPLEMENTATION_STATUS.md` and `ARCHITECTURE_DECISIONS.md` stop at 2026-08-22; `CHANGELOG_AI_TRANSFORMATION.md` stops at 2026-09-11; `AI_TASK_STATE.md` stops at 2026-08-25 mid-task. None mention HR/Payroll, Group Training, Notification Center, Complete Inventory OS, or Business OS — all built and merged since. Add changelog/ADR/status entries for each, following the existing "what's built, what's not, why" discipline these docs already established. Do this *after* B-P0-1/B-P0-2 so the new entries describe the corrected state, not the raw-SQL state. |
| B-P1-6 | Confirm public-endpoint rate limiting is actually applied | ⬜ | `public_endpoint_rate_limits` table exists (migration `20260923010000`) for the `@Public()` routes (`portal/bootstrap/:token`, `kiosk/check-in`). Verify it's wired into a guard/interceptor and not just a schema stub — these are unauthenticated, internet-facing routes. |

## P2 — Real gaps, not urgent

| # | Item | Status | Detail |
|---|---|---|---|
| B-P2-1 | Replace `ILIKE`-scan search with real full-text search | ⬜ | `src/search/search.service.ts` does raw `ILIKE` across tables via `$queryRawUnsafe`. Fine at current scale; add Postgres `pg_trgm`/`tsvector` indexes before member/product counts grow large. |
| B-P2-2 | Org-wide reporting/export | ⬜ | CSV export only exists for member bulk actions (`member-bulk.service.ts`). No general revenue/attendance/inventory export for accountants/owners. |
| B-P2-3 | Reassess AI Supervisor/specialist-agent architecture | ⬜ | Deliberately deferred (AI-13/AI-17) since nothing needed routing between toolsets. Now at 20 tools across intelligence/CRM/workouts/nutrition/actions/briefing — re-evaluate whether a router is warranted, per the trigger condition AI-17 itself names ("a genuinely distinct specialist toolset need"). |

## P3 — Polish / future

| # | Item | Status | Detail |
|---|---|---|---|
| B-P3-1 | i18n-aware communication templates | ⬜ | `MessageTemplate`/email templates are English-only strings; no locale field. Needed before F-P3-1 (frontend i18n) is meaningful end-to-end. |
| B-P3-2 | Additional payment gateways/currencies as new markets require | ⬜ | Stripe + Razorpay cover most cases today; revisit only when a real market need appears. |

---

## Process fix (applies to every item above)

Going forward, update `IMPLEMENTATION_STATUS.md`/`CHANGELOG_AI_TRANSFORMATION.md` **in the same
PR** that ships a module, not in a later catch-up pass — the ~5-week documentation gap this audit
found (Aug 22 → Sep 23 undocumented) is what made B-P0-1 through B-P0-3 invisible until now.
