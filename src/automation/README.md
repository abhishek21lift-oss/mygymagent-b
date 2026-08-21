# automation

**Status: P1 scope built and tested (5 automations); PT expiry explicitly blocked; approval workflow deferred to P3.**

## What exists

Trigger -> Conditions -> Action -> Audit, for five automations, built on top of `QueueModule`
(BullMQ) and `CommunicationsService`:

| Automation | Trigger | Cooldown | Source |
|---|---|---|---|
| Membership renewal reminder | ACTIVE membership, `endDate` within 7 days | 3 days | `scanners/membership-renewal.scanner.ts` |
| Payment overdue reminder | ACTIVE/PENDING membership, `startDate` passed, net paid (payments minus refunds) < `price` | 5 days | `scanners/payment-overdue.scanner.ts` |
| Inactive member recovery | ACTIVE member, no Attendance (or ever) in 30+ days | 14 days | `scanners/member-inactive.scanner.ts` |
| Lead follow-up reminder | Incomplete `LeadFollowUp` past `dueAt`, lead has an assignee | 1 day | `scanners/lead-followup.scanner.ts` |
| Low stock alert | `Product.quantityOnHand` crosses at-or-below `reorderLevel` | 1 day (per product+recipient) | `inventory-low.listener.ts` (real-time, not a scan) |

The first four run as BullMQ repeatable jobs (`AutomationSchedulerService`, daily at 08:00 UTC,
registered via `Queue.upsertJobScheduler` -- idempotent across restarts, no separate scheduler
abstraction needed since BullMQ already provides the cron primitive plus retries/backoff/failure
tracking via `QueueModule`'s `defaultJobOptions`). The fifth is event-driven: `StockMovementsService`
has emitted `inventory.low` since the P0 concurrency fix with no listener until now.

**Audit + idempotency:** every attempt -- sent, skipped (no MARKETING consent), or failed -- writes
an `AutomationRun` row (`organizationId`, `key`, `subjectId`, `status`, `detail`).
`AutomationRunService.attempt()` checks for a recent row before trying again, which is what makes
cooldowns work: a membership expiring in 7 days doesn't get re-emailed on days 6, 5, 4...

**No approval step.** The master prompt's shape is Trigger -> Conditions -> AI/Action ->
**Approval-if-required** -> Execute -> Audit. Every automation here is a notification send --
TRANSACTIONAL or MARKETING-gated email, never money movement or a destructive action -- so
"Approval-if-required" trivially resolves to "not required" for all five. A real approval
workflow (Action Center, human-in-the-loop for higher-risk actions) is P3 scope, once the
Automation Engine actually does something riskier than sending an email.

## What's explicitly blocked, not faked

**PT (personal training) expiry reminders** are not built. The master prompt lists this as a P1
starting automation, but there is no PT package/session data model in this schema (confirmed by
the 2026-08-21 audit) -- no way to know when a PT package "expires" without inventing one. Per
this project's "do not fake features" rule, this is left undone rather than approximated on data
that doesn't exist. Building it requires a decision on a minimal PT-session/package model first,
which the master prompt itself doesn't specify -- flagged for the user rather than guessed at.

## Known simplifications

- **Payment overdue is a computed outstanding balance, not an invoice system.** This schema has no
  accounts-receivable/invoice model -- `Payment` rows only exist once money has actually been
  collected. "Overdue" here means `membership.price - (payments - refunds) > 0` for a membership
  whose `startDate` has passed, not "N days past a due date," because there is no due-date concept
  to be N days past. Honest about what it actually knows.
- **Low-stock alert recipients** are every user in the org holding `inventory.manage` through a
  role grant (see `AutomationScanProcessor.sendLowStockAlert()`'s comment) -- doesn't apply a
  per-user DENY override the way `PermissionsService.hasPermission()` does for a live request.
  Acceptable for an internal stock alert; would need fixing before this pattern is reused for
  anything higher-stakes.
- **Fixed daily schedule (08:00 UTC), same for every org.** No per-org timezone/schedule
  configuration -- not asked for by the master prompt's P1 scope, and there's nowhere in the
  schema to store it yet.
- **Inactive-member recovery threshold (30 days) and all cooldowns are fixed constants**, not
  per-org configurable. Same reasoning as the schedule.

## Tested

`test/automation.e2e-spec.ts` -- against real Postgres, real Redis (BullMQ), and real SMTP (see
`test/utils/smtp-capture-server.ts`): each scanner's trigger condition, its cooldown suppressing a
second run, the payment-overdue balance calculation from real Payment/Refund rows, the
MARKETING-consent SKIPPED path for inactive-member recovery, and the real-time inventory-low event
-> queue -> email path end to end.
