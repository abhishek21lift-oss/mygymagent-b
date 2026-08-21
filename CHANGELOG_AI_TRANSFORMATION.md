# Changelog — AI Transformation

Dated, itemized log of changes made under the MY GYM AGENT AI-transformation master prompt. Each
entry names the real files changed and the real test that proves it, per this codebase's existing
discipline. See `IMPLEMENTATION_STATUS.md` for the current phase summary and
`ARCHITECTURE_DECISIONS.md` for the reasoning behind non-obvious choices.

## 2026-08-21 — P0: Fix First

**Source:** 2026-08-21 forensic audit (six parallel domain audits across `mygymagent-f` and
`mygymagent-b`), P0 findings 1–5 of the master prompt.

### 1. Fixed `/ai/chat` branch + trainer assignment authorization vulnerability (audit F-01, 🔴 critical)

Before: the AI tool executor's `ToolCallContext` carried only `{organizationId, userId}`. Every
tool call into a domain service (`read_member`, `read_attendance`, `create_followup`, etc.) left
branch scope and assignment scope at their permissive defaults — a TRAINER limited to
`members.read_assigned` could ask the assistant to look up any member in the org and get a real
answer, bypassing the exact restriction `GET /members/:id` enforces over REST.

After: `ToolExecutorService.resolveAccess()` re-derives each tool's REST-equivalent permission
(e.g. `read_member` → `members.read` OR `members.read_assigned`; `create_followup` →
`leads.manage`) and resolves branch/assignment scope the same way `PermissionsGuard` does, before
the tool touches any domain service. `AiController` now forwards the raw `x-branch-id` header
(via the existing `@RequestedBranchId()` decorator) through `AiService.chat()` into the tool
context, as an unverified hint reconciled per-tool — never trusted directly.

- Changed: `src/ai/tools/tool-executor.service.ts`, `src/ai/ai.controller.ts`,
  `src/ai/ai.service.ts`, `src/ai/ai.module.ts` (imports `RbacModule` for `PermissionsService`)
- Tested: `test/ai.e2e-spec.ts` — new `describe('tool executor enforces role/assignment scope...')`
  block: a trainer can read their own assigned member via `read_member` but is rejected (404,
  "Member not found") for an unassigned one; a trainer (holds `ai.generate` but not `leads.manage`)
  is rejected outright (403-shaped) from `create_followup`.
- Known limitation, not fixed by this change: assignment scoping still doesn't apply to
  `/memberships/:id`, `/attendance`, or `/workout-assignments` at the REST layer (audit F-05) —
  that's a separate, pre-existing gap outside `/ai/chat`'s scope, tracked as P1 work.

### 2. Fixed RBAC "DENY > ALLOW" precedence bug (audit F-04, 🟠 risky)

Before: `PermissionsService.hasPermission()` picked one `UserPermissionOverride` row via
`findFirst` ordered by `branchId DESC`, intending "branch-specific beats org-wide." PostgreSQL's
`DESC` defaults to NULLS FIRST, so the org-wide row (`branchId IS NULL`) was returned *before* a
branch-specific one — inverting the documented "DENY always wins" invariant whenever a user held
both an org-wide ALLOW-shaped grant and a branch-specific DENY for the same permission.

After: fetches every matching override row and applies "DENY always wins" explicitly —
`overrides.some(o => o.effect === 'DENY')` short-circuits to `false` before any ALLOW is
considered. `getEffectivePermissions()` (feeds `/auth/me`, previously order-dependent for the same
reason via a single-pass Set mutation) fixed the same way: all ALLOWs applied first, then every
DENY removed.

- Changed: `src/rbac/permissions.service.ts`
- Tested: `src/rbac/permissions.service.spec.ts` (mocked Prisma — the exact regression scenario:
  an org-wide ALLOW row and a branch-specific DENY row, ALLOW-first in the mock's return order,
  asserting DENY still wins) and `test/permission-override-precedence.e2e-spec.ts` (new file —
  same scenario against a real Postgres database via a real `UserPermissionOverride` row, closing
  the "unverified at runtime" gap the audit called out).

### 3. Fixed inventory overselling concurrency race (audit finding, 🟠 risky)

Before: `StockMovementsService.record()` read `product.quantityOnHand`, computed the would-be new
quantity, and only *then* opened a transaction to write it. Two concurrent `SALE` movements
against the last unit on hand could both read the same pre-decrement quantity, both pass the
`>= 0` guard, and both apply — driving stock negative, violating the module's own documented
invariant ("a movement that would take stock negative is rejected with 400 rather than silently
clamped").

After: the guard is now the `WHERE` clause of a conditional `updateMany` inside the transaction —
`quantityOnHand: { gte: -delta }` for a decrementing movement — evaluated atomically by Postgres.
`count === 0` means the guard rejected the movement (the product's existence was already confirmed
before the transaction), which aborts the whole transaction, including the stock-movement ledger
row that would otherwise have been created alongside a rejected update.

- Changed: `src/inventory/stock-movements.service.ts`
- Tested: `test/inventory.e2e-spec.ts` — new test fires two concurrent `SALE` requests against a
  product with exactly 1 unit on hand via `Promise.all`, asserts exactly one gets `201` and the
  other `400`, and that `quantityOnHand` ends at `0`, never `-1`.

### 4. Fixed payment/refund concurrency race (audit finding, 🟠 risky)

Before: `PaymentsService.refund()` read existing `Refund` rows and computed the remaining
refundable balance outside any transaction. Two concurrent refund requests against the same
payment could both read "nothing refunded yet," both pass the remaining-balance check, and both
commit — refunding more than the original payment amount.

After: the payment row is locked (`SELECT ... FOR UPDATE`, inside an interactive transaction) for
the duration of the balance computation and the write. A concurrent second request blocks on the
lock until the first transaction commits, then re-reads the now-current refund total under the
same lock before deciding.

- Changed: `src/billing/payments.service.ts`
- Tested: `test/payments.e2e-spec.ts` — new test fires two concurrent full-refund requests
  (`POST /payments/:id/refund` with no `amount`, defaulting to "remaining") against a $100 payment
  via `Promise.all`, asserts exactly one gets `201` and the other `400`, and that the sum of all
  refund rows against the payment is exactly `100`, never `200`.

### 5. Corrected the security test matrix to reflect real executable coverage (audit F-17, 🟠 risky)

Before: `docs/security/overview.md`'s test matrix had ✅ rows that, on independent re-verification,
cited a test that did not prove the row's claim — most notably "refresh token reuse detection,"
which does not exist in the code at all (only rotation does), and "user without permission →
restricted endpoint," which cited a test whose own comment admits it's a wrong-tenant-id sanity
check, not a permission test.

After: every row re-verified by opening its cited test file. Rows that overclaimed are corrected
in place — narrowed to what's actually tested, with the real gap stated plainly — rather than left
standing or silently deleted. Rows for the two concurrency fixes and the permission-override fix
above are added, since they're now genuinely, testably true. The matching false claim in
`docs/architecture/adr/0002-auth-token-strategy.md` ("a reused old refresh token is treated as a
compromise signal") is corrected the same way, with the removal explicitly noted rather than
silently edited out.

- Changed: `docs/security/overview.md`, `docs/architecture/adr/0002-auth-token-strategy.md`
- No new test — this item is documentation-only, matching its scope in the master prompt.

### Verification (ran after every item above, not just at the end)

```
npx tsc --noEmit -p tsconfig.json   # clean
npm run lint:ci                      # clean
npm test                             # 11/11 unit tests passing (was 8; +3 for the override fix)
npm run test:e2e                     # 113/113 e2e tests passing across 18 suites (was 107/17; +6 new regression tests, +1 new suite)
```

All e2e tests ran against real Postgres, real Redis, and real s3rver — not mocks, matching this
project's existing testing discipline (`docs/testing/strategy.md`).

## 2026-08-21 — P1: Communication (email)

**Source:** Master prompt's P1 Communication item. User's explicit choice (asked via
`AskUserQuestion` since real WhatsApp/SMS/push providers need paid credentials this environment
doesn't have, one of the master prompt's own stop conditions): build a real SMTP-based email
provider now, defer WhatsApp/SMS/push as designed-but-unwired.

### Built

A new `src/communications/` module replaces the old `src/common/mailer/` logging stub everywhere
it was used (auth email verification, password reset, staff invites, welcome emails):

- **`CommunicationsService`** — the single place that turns "send this kind of message to this
  person" into an outbound attempt: template resolution (org override, falling back to system
  default), per-org branding (`Organization.emailFromName`/`emailReplyTo`), MARKETING-category
  consent gating (checks `MemberConsent`, records `SKIPPED_NO_CONSENT` rather than sending),
  delivery logging (`MessageLog`: PENDING → SENT/FAILED/SKIPPED_NO_CONSENT, with `attempts` and
  `errorMessage`), then provider dispatch.
- **`SmtpEmailProvider`** — real SMTP delivery via `nodemailer`, config-gated on
  `SMTP_HOST`/`SMTP_FROM_ADDRESS` (same optional-integration pattern as `FileStorageService`'s S3
  config): unset means every send throws `ChannelNotConfiguredError`, recorded as `FAILED`, rather
  than the app failing to boot.
- **`MessageTemplateService`** — resolves a template by (org override → system default) and does
  `{{variable}}` substitution. 9 system-default templates seeded by `prisma/seed.ts` from
  `default-templates.catalog.ts` (welcome, email verification, password reset, staff invite,
  membership renewal reminder, payment overdue reminder, inactive-member recovery, lead follow-up
  reminder, low-stock alert — the last 5 are ready for the Automation Engine, not yet called by
  anything).
- **WhatsApp/SMS/Push** — typed `MessageProvider` interface, bound to an
  `UnimplementedChannelProvider` that throws clearly rather than faking delivery. Swapping in a
  real provider later is a new class + one DI binding change.
- Schema: `MessageTemplate` (per-org override or system default, unique on
  `organizationId+key+channel`), `MessageLog` (nullable `organizationId` — mirrors `AuditLog`,
  since a platform admin with `User.organizationId: null` can trigger a send, e.g. their own
  password reset), `Organization.emailFromName`/`emailReplyTo`, `CommunicationChannel`/
  `MessageCategory`/`MessageStatus` enums. Two migrations (the second corrects `MessageLog`'s
  `organizationId` to nullable after the first was already applied).
- Callers migrated off the old stub: `AuthService.register()`/`forgotPassword()`,
  `UsersService.invite()` (now `sendStaffInvite` instead of misusing `sendPasswordReset`),
  `WelcomeEmailProcessor` (now takes `organizationId` in its job payload, threaded from
  `MemberCreatedListener`). `src/common/mailer/` deleted — nothing references it.

### Tested

- `test/auth-password-reset.e2e-spec.ts` (new) — proves password reset is genuinely
  production-functional, per the master prompt's explicit requirement: registers a real account,
  requests a reset, receives a real email over real SMTP (`test/utils/smtp-capture-server.ts`, a
  local `smtp-server`-based capture server standing in for a mail relay the same way `s3rver`
  stands in for S3 — started/stopped by `test/global-setup.ts`/`global-teardown.ts`, sharing Jest's
  long-lived orchestrator process rather than a subprocess), extracts the real token from the real
  email body, redeems it, and confirms login works with the new password and fails with the old
  one. A second test confirms an unknown email sends nothing and doesn't error.
- `test/notifications-queue.e2e-spec.ts` — unchanged test, now exercising real SMTP delivery
  instead of a stub.
- `src/notifications/welcome-email.processor.spec.ts` — updated to mock `CommunicationsService`.

### Two real bugs found and fixed along the way (not test-only artifacts)

1. **`SMTP_SECURE` env var coercion bug** — `z.coerce.boolean()` is `Boolean(value)`, which is
   `true` for any non-empty string, including the literal text `"false"`. Any deployment setting
   `SMTP_SECURE=false` got `true` silently. Fixed with an explicit string-match transform.
   (`ARCHITECTURE_DECISIONS.md` AI-7.)
2. **Shutdown-ordering race hanging `app.close()`** — `QueueConnection` (shared Redis connection
   for BullMQ) quit its connection in `onModuleDestroy`, a shutdown phase that completes *before*
   `@nestjs/bullmq`'s worker-closing `onApplicationShutdown` hook even starts. If a job (e.g. the
   welcome-email job) was still active when shutdown began, its Redis connection died mid-flight
   and the worker could never report completion — `worker.close()`, and therefore `app.close()`,
   hung forever. Real production risk (a SIGTERM during an in-flight job), not an e2e-only issue —
   just never triggered before because the old stub mailer was fast enough to never lose the race.
   Fixed by moving `QueueConnection` to `OnApplicationShutdown`, the same phase, relying on
   `BullModule.forRootAsync`'s `inject: [QueueConnection]` dependency edge for correct ordering
   within that phase. (`ARCHITECTURE_DECISIONS.md` AI-8.)

- Changed: `src/communications/**` (new), `src/auth/auth.service.ts`, `src/auth/auth.module.ts`,
  `src/users/users.service.ts`, `src/users/users.module.ts`, `src/notifications/*`,
  `src/queue/queue.module.ts`, `src/config/env.validation.ts`, `prisma/schema.prisma` +
  2 migrations, `prisma/seed.ts`, `.env.test`, `test/global-setup.ts` (+ new
  `test/global-teardown.ts`), `test/jest-e2e.json` (`testTimeout: 15000`), `package.json`
  (`nodemailer`, `@types/nodemailer`, `smtp-server`, `@types/smtp-server`). Deleted:
  `src/common/mailer/`.

### Verification

```
npx tsc --noEmit -p tsconfig.json   # clean
npm run lint:ci                      # clean
npm test                             # 11/11 unit tests passing
npm run test:e2e                     # 115/115 e2e tests passing across 19 suites (was 113/18; +2)
```

All e2e tests ran against real Postgres, real Redis, real s3rver, and real SMTP (the local capture
server above) — not mocks.
