# Architecture Decisions — AI Transformation

Decisions made specifically during the MY GYM AGENT AI-transformation work (P0 onward). This is
separate from `docs/architecture/adr/` (pre-existing ADRs for the base platform) — those are
unchanged and still authoritative for what they cover. Each entry follows the same
decision/trade-offs shape as the existing ADRs, kept lightweight since not every change here
warrants a full ADR.

---

## AI-1: Per-tool permission resolution lives in `ToolExecutorService`, not a new guard layer

**Context:** F-01 — the AI tool executor authorized only on `ai.generate` and never re-checked a
tool's REST-equivalent permission or branch/assignment scope.

**Decision:** Added a private `resolveAccess()` method to `ToolExecutorService` that re-implements
`PermissionsGuard`'s branch-scope resolution (same two-query pattern: check with the branch id,
then re-check without one to see if the grant is org-wide) for a list of candidate permission
keys, called once per tool before it touches a domain service. `ai.generate` continues to gate the
`/ai/chat` endpoint itself (whether the caller can talk to the assistant at all); each tool now
additionally enforces its own resource permission (whether the caller can do *that specific thing*
through any means, AI or REST).

**Alternatives considered:**
- *A `PermissionsGuard`-style NestJS guard on the AI controller.* Rejected: a single HTTP request
  can invoke multiple different tools in one tool-calling loop, each needing a different
  permission check — a route-level guard can only express one check per route.
- *Passing the caller's full effective permission set into the tool executor once, and having each
  tool check membership in that set.* Considered, but `getEffectivePermissions()` doesn't resolve
  branch/assignment scope (it's a flat set for UI display), and scope resolution is exactly the
  part that was actually broken (F-01's `branchScope`/`assignmentScope` being dropped). Rejected in
  favor of reusing the guard's actual scope-resolution logic per tool.

**Consequences:** Every future AI tool must call `resolveAccess()` (or equivalent) before touching
a domain service — this is now the pattern to follow, not `PermissionsGuard`'s route decorators,
since tools aren't routes. This should be revisited once the Gym Brain phase (P3) introduces a
supervisor/specialist-agent architecture — at that point, a shared permission-resolution service
usable by both the REST guard and the AI layer (rather than two independent implementations of the
same two-query logic) is the right consolidation, not before.

---

## AI-2: `requestedBranchId` threaded as an unverified hint, matching `@RequestedBranchId()`

**Context:** The AI tool executor needs *a* branch id to reconcile against the caller's grants,
the same way `PermissionsGuard` reconciles the `x-branch-id` header. There's no header on a tool
call, though — only on the outer `/ai/chat` HTTP request.

**Decision:** `AiController` reads the raw `x-branch-id` header via the existing
`@RequestedBranchId()` decorator and threads it through `AiService.chat()` into
`ToolCallContext.requestedBranchId`, documented explicitly as an unverified claim (never used as
the sole access gate), exactly mirroring how `@RequestedBranchId()` is used everywhere else in the
codebase (e.g. `MembersController.list()`). `resolveAccess()` is what turns this raw hint into an
enforced `branchScope`, never the reverse.

**Consequences:** A single `x-branch-id` header applies to every tool the model calls during one
chat turn. This is correct for today's tool set (each tool independently re-verifies the caller
actually holds the permission for that branch) but would need revisiting if a future tool needed
to reason about *multiple* branches within one conversation turn — not a case any of the current 6
tools have.

---

## AI-3: DENY-wins fix evaluates all matching override rows, not a smarter single query

**Context:** F-04 — `findFirst` ordered by `branchId DESC` relied on an implicit assumption
(branch-specific sorts before org-wide) that Postgres's NULLS FIRST default for `DESC` silently
violated.

**Decision:** Replaced the single `findFirst` with `findMany` over the same `WHERE` clause
(org-wide OR the requested branch), then applied "DENY wins over ALLOW" explicitly in application
code with two `.some()` checks. `getEffectivePermissions()` (a separate method, used for
`/auth/me`) had the same class of order-dependent bug in its Set-based accumulation and was fixed
the same way (two passes: add every ALLOW, then remove every DENY).

**Alternatives considered:** A single query with `ORDER BY effect = 'DENY' DESC` (or similar) to
let Postgres pick the "right" row directly. Rejected: it re-introduces the same "trust the
database's row-selection order to encode a business rule" pattern that caused the original bug,
just with a different sort key. Fetching all rows and reasoning about them explicitly in
TypeScript is slower by a constant factor (rarely more than 1-2 override rows per user/permission
in practice) but is straightforward to read, test, and get right.

---

## AI-4: `SELECT ... FOR UPDATE` for the refund race, not Serializable isolation

**Context:** F-? (audit-identified) — `PaymentsService.refund()` read existing refunds and computed
the remaining balance outside any transaction, so two concurrent refund requests against the same
payment could both pass the balance check and both commit.

**Decision:** Lock the `Payment` row for the duration of an interactive transaction via
`tx.$queryRaw` with a `SELECT id FROM payments WHERE id = ... FOR UPDATE` tagged template, then
re-read the refund total and re-validate inside that same transaction. A concurrent second request
blocks on the row lock until the first transaction commits or rolls back, then sees the
up-to-date refund total.

**Alternatives considered:**
- *`Prisma.TransactionIsolationLevel.Serializable` on the whole transaction.* Rejected for this
  fix: Postgres aborts one of two conflicting serializable transactions with a `40001`
  serialization-failure error, which the caller must detect and retry — that's a real pattern, but
  it adds a retry loop for a fix that a simple row lock solves without one, and would apply
  Serializable to reads that don't need it (`getOne()` outside the transaction is still a
  plain read).
- *A database-level `CHECK` constraint on total refunds ≤ payment amount.* Not expressible cleanly
  in Postgres without a trigger (the check spans two tables), and a trigger would duplicate the
  business rule already expressed in `PaymentsService`, in a place far from where the rest of this
  codebase's business logic lives.

**Consequences:** This is the first and only additional raw SQL in the codebase beyond the
pre-existing health-check `SELECT 1` (see the code comment at the call site) — `SELECT ... FOR
UPDATE` has no Prisma query-builder equivalent as of the Prisma version this project pins. Any
future money-adjacent read-then-write that needs the same guarantee (e.g. a future PT
session-balance ledger, per the P1 roadmap) should reach for the same pattern rather than
inventing a new one.

---

## AI-5: Inventory oversell fix uses a conditional `updateMany`, not a row lock

**Context:** The same class of race as AI-4, but for `Product.quantityOnHand`.

**Decision:** Replaced the read-then-check-then-`update` sequence with a single
`tx.product.updateMany({ where: { id, quantityOnHand: { gte: -delta } }, data: { quantityOnHand:
{ increment: delta } } })` and checked `count === 0` to detect the guard rejected the movement.

**Why not the same `FOR UPDATE` pattern as AI-4?** Both work. The conditional-update form was
preferred here specifically because the invariant being protected (`quantityOnHand` never
negative) is expressible entirely as a `WHERE` predicate on the row being written, with no need to
read anything back before deciding — genuinely simpler than a lock in this one case. The refund
case (AI-4) needed to read and sum an unbounded set of *other* rows (existing refunds) before it
could even compute the value to check, which a `WHERE` predicate can't express — hence the lock
there instead. Two different problems, two different (both standard) tools; not an inconsistency
to reconcile later.

**Consequences:** Same as AI-4's — this is the pattern for any future "decrement a counter,
never below zero, under concurrency" problem in this codebase (e.g. a future PT session-balance
consumption).
