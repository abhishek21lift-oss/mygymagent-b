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
