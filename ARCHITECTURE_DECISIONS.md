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

---

## AI-6: Email only for P1 Communication; WhatsApp/SMS/push get typed interfaces, not implementations

**Context:** The master prompt's P1 Communication item calls for "a real provider abstraction —
email/WhatsApp/SMS/push." Every real WhatsApp/SMS/push provider (Twilio, WhatsApp Business API,
a push provider) needs a paid account and real credentials this environment doesn't have — one of
the master prompt's own explicit stop conditions ("unavailable credentials, paid services").

**Decision:** Asked the user via `AskUserQuestion`. They chose: build a real SMTP-based email
provider now (works with any mailbox/relay they already have — no new paid signup required) and
leave WhatsApp/SMS/push as designed-but-unwired: a typed `MessageProvider` interface
(`src/communications/interfaces/message-provider.interface.ts`) with an `UnimplementedChannelProvider`
that throws `ChannelNotConfiguredError` clearly on every call, bound in
`communications.module.ts`. `CommunicationsService.send()` is channel-agnostic — swapping in a
real WhatsApp/SMS/push provider later is a new class implementing `MessageProvider` plus a DI
binding change, not a rewrite.

**Consequences:** Every WhatsApp/SMS/push-shaped automation (P1's Automation Engine, later phases)
must call through `CommunicationsService` the same as email does, so it inherits real delivery the
moment a provider is wired in, rather than needing its own retrofit. Explicitly not faked: no
provider "pretends" to send and silently drops the message — every attempt on an unwired channel
throws and gets recorded as `FAILED` in `MessageLog`, visible rather than silent.

---

## AI-7: `SMTP_SECURE` validated as an explicit string match, not `z.coerce.boolean()`

**Context:** Found while building the password-reset e2e test against a real local SMTP server:
`SMTP_SECURE="false"` in `.env.test` was making `SmtpEmailProvider` attempt an implicit-TLS
connection anyway, failing with a TLS handshake error against the plaintext test server. Root
cause: `z.coerce.boolean()` is `Boolean(value)` under the hood, which is `true` for *any*
non-empty string — including the literal text `"false"`. This is a real production bug, not a
test-only issue: any deployment setting `SMTP_SECURE=false` in its environment would silently get
`true`.

**Decision:** Replaced `z.coerce.boolean().default(false)` with an explicit
`z.string().default('false').transform((v) => v === 'true')` in `src/config/env.validation.ts`.
Only the literal string `"true"` produces `true`; everything else (including unset, `"false"`, or
a typo) produces `false` — matching what a human reading `SMTP_SECURE=false` in an env file
actually expects.

**Consequences:** No other env var in this schema used `z.coerce.boolean()` (checked), so this
was the only instance of the bug. Any future boolean env var should use this string-match pattern,
not `z.coerce.boolean()`.

---

## AI-8: `QueueConnection`'s Redis-quit moved from `OnModuleDestroy` to `OnApplicationShutdown`

**Context:** Found via the same password-reset/welcome-email e2e work: `test/crm.e2e-spec.ts`
(and, intermittently, any spec that creates a member with an email and doesn't explicitly wait for
the resulting welcome-email job) started hanging forever on `app.close()` in `afterAll` — not
slow, a genuine permanent hang, confirmed by instrumenting every shutdown hook. The trace showed
`QueueConnection.onModuleDestroy()` (which quits the shared ioredis connection every BullMQ
queue/worker uses) and `PrismaService.onModuleDestroy()` both completing *before* the
welcome-email job — still actively processing — had finished. NestJS runs `onModuleDestroy` hooks
across the *entire app* to completion before starting the `onApplicationShutdown` phase, and
`@nestjs/bullmq`'s worker-closing logic (which waits for an active job to finish) is itself an
`onApplicationShutdown` hook, not `onModuleDestroy` — so `QueueConnection`, declared as
`OnModuleDestroy`, was always racing ahead of it. Once the shared Redis connection was quit mid-job,
the BullMQ worker could no longer report the job's completion back to Redis, so `worker.close()`
(and therefore `app.close()`) never resolved. This was a **latent, real production bug** — it
never surfaced before because the old stub `MailerService` resolved so fast (no real I/O) that a
welcome-email job was essentially always fully complete before any conceivable `app.close()`/
shutdown could race it. Real SMTP I/O (even to localhost) added just enough event-loop ticks to
open the window routinely.

**Decision:** Changed `QueueConnection` in `src/queue/queue.module.ts` from
`implements OnModuleDestroy` to `implements OnApplicationShutdown`, keeping it in the same
shutdown phase as `@nestjs/bullmq`'s worker-close hook. `BullModule.forRootAsync`'s
`inject: [QueueConnection]` gives NestJS the dependency edge it needs to destroy the queue/workers
before `QueueConnection` itself, in that shared phase — the same guarantee NestJS already gave for
`onModuleDestroy` ordering, now applying to the phase that actually matters here.

**Consequences:** This is a real production shutdown-safety fix, not merely an e2e-test fix — a
production deploy's graceful shutdown (SIGTERM → `app.close()`) had the identical risk of dropping
an in-flight job's completion report whenever a job happened to be mid-processing at shutdown time.
Also bumped `test/jest-e2e.json`'s `testTimeout` from Jest's 5000ms default to 15000ms: real,
sequential Postgres+Redis+SMTP+Nest-bootstrap work across 19 e2e suites occasionally needs more
than 5s for a single `beforeAll`/`afterAll`, independent of the hang this entry fixes.

---

## AI-9: Scheduler built on BullMQ's own `upsertJobScheduler`, not a second abstraction

**Context:** The master prompt's P1 scope calls for "Scheduler + Jobs infrastructure" as its own
item, separate from "Automation Engine." BullMQ (already the app's job-queue library, via
`QueueModule`) has had a first-class repeatable-job primitive since v5 --
`Queue.upsertJobScheduler(id, {pattern}, {name, data})` -- that gives idempotent registration (safe
to call on every app boot), and every job it produces inherits the queue's `defaultJobOptions`
(retries, exponential backoff, `removeOnFail`), which is exactly "retries/backoff, failure
tracking" from the master prompt's own description of what the Scheduler needs.

**Decision:** `AutomationSchedulerService` (an `OnApplicationBootstrap` provider) calls
`upsertJobScheduler` once per daily scan on every boot. No new scheduling library, no cron
abstraction layered on top of BullMQ's own.

**Alternatives considered:** `@nestjs/schedule` (node-cron under the hood) -- rejected because it
runs in-process with no persistence or distribution story; a job it "misses" during a restart is
just gone, whereas BullMQ's repeatable jobs are durable in Redis and BullMQ itself already owns
this app's only other async-job infrastructure. Introducing a second async-work primitive next to
BullMQ, for no capability BullMQ doesn't already have, would be exactly the kind of unnecessary
abstraction this project's engineering discipline avoids.

**Consequences:** Any future scheduled/recurring job (P2/P3) should register through this same
pattern (`upsertJobScheduler` on the `automation` queue, or a queue registered the same way), not a
new scheduler. A per-organization schedule (different orgs, different timezones) isn't supported
yet -- `AutomationSchedulerService` registers one fixed UTC time for everyone -- and would need a
config field this schema doesn't have today plus per-org scheduler registration, not a redesign.

---

## AI-10: Automation Engine's five P1 automations are notification-only; PT expiry is explicitly not built

**Context:** The master prompt names six starting automations for P1: membership renewals, payment
reminders, inactive-member recovery, PT expiry, lead follow-ups, low-stock alerts. Its own explicit
rules ("Do NOT fake features, AI, analytics, automation or integrations") and the audit's finding
that no PT session/package data model exists in this schema meant PT expiry could not be built
honestly -- there's no field anywhere recording when a member's PT allotment "expires."

**Decision:** Built the five automations the data model actually supports
(`src/automation/scanners/` + `inventory-low.listener.ts`), each following Trigger -> Conditions ->
Action -> Audit against real Membership/Payment/Refund/Member/Attendance/LeadFollowUp/Product data
-- no fabricated fields, no invoice model invented for "payment overdue" (see that scanner's
comment for how outstanding balance is computed from real Payment/Refund rows instead). Left PT
expiry unbuilt, documented in `src/automation/README.md` and `IMPLEMENTATION_STATUS.md` as blocked
on a data-model decision (a minimal PT-session/package model would need to be designed first --
not specified by the master prompt, so not guessed at) rather than silently dropped or faked
against a field that doesn't exist.

**Decision:** No approval step ("Approval-if-required" from the master prompt's shape) for any of
these five. Every action here is sending a notification -- the same risk tier as the existing
password-reset/welcome emails, which have never required approval. A real approval workflow
(Action Center, human-in-the-loop review) is explicitly P3 scope in the master prompt itself,
introduced once the Automation Engine does something riskier than a notification send (e.g.
auto-applying a discount, cancelling a membership) -- building that machinery now, with nothing
that actually needs it, would be exactly the "flashy AI UI before the operational foundation"
the master prompt says not to build first.

**Consequences:** `AutomationRun`'s `status` enum (`SENT`/`SKIPPED`/`FAILED`) has no `PENDING_APPROVAL`
value yet -- adding one, plus the workflow around it, is real P3 work, not a trivial follow-up.
Every automation added between now and P3 should keep to the same notification-only risk tier this
decision assumes; the first automation that needs to *change* data (not just notify about it)
is the trigger to build the approval step for real, not before.

---

## AI-11: Revenue is reported per-currency, never summed across currencies

**Context:** Building `FinanceService.getRevenueSummary()` for the P1 Revenue & Finance item,
found that `Payment.currency` and `Membership.currency` are per-record fields (default `"USD"`,
but overridable per plan/payment), not fixed per organization. A naive `SUM(amount)` across every
payment in a period would silently add, say, 100 USD and 50 EUR into a meaningless "150," with no
unit attached -- exactly the kind of unreliable calculation the master prompt says not to build a
report (or later, a chart) on.

**Decision:** Every revenue/outstanding-balance figure is grouped by `currency` and returned as an
array (one entry per currency actually seen), never flattened into one number. `FinanceService`
uses Prisma's `groupBy` for the (potentially large) `Payment` aggregation, and a fetch-and-reduce
over the (much smaller) `Refund`/`Membership` sets where a currency has to be read off a joined
relation `groupBy` can't reach directly.

**Alternatives considered:** Assume single-currency-per-org and sum flatly, since in practice most
gyms probably do bill in one currency. Rejected: "probably" isn't a basis for a financial number a
gym owner or an AI tool might act on, and the schema explicitly allows per-payment currency --
building on an assumption the data model itself doesn't guarantee is exactly the "unreliable
calculation" the master prompt warns against.

**Consequences:** Any future revenue/financial computation (P2 intelligence, a future dashboard,
an AI finance tool) must follow the same per-currency shape, not introduce a second, flatter
aggregation elsewhere that quietly reintroduces the cross-currency-sum bug this entry avoids.

---

## AI-12: `notComputable` is a first-class, explicit field in the revenue response, not an omission

**Context:** The master prompt's Revenue & Finance item lists product revenue, PT revenue,
discounts, expenses, payroll, and commissions alongside membership/payment revenue. None of the
first six are computable from this schema (see `src/analytics/README.md` for the specific gap
behind each one -- no price on `StockMovement`, no PT data model, no discount/expense/payroll
fields, no payment-to-staff attribution for `StaffProfile.commissionRate`). Simply omitting them
from the response would look identical to "computed as zero" to any caller -- a dashboard or an AI
tool reading the response has no way to distinguish "no product revenue this period" from "product
revenue isn't tracked at all."

**Decision:** `RevenueSummary.notComputable` is always present, always lists all six, each with a
one-sentence reason. A caller (this phase's controller; a future dashboard; a future AI finance
tool) has to actively ignore an explicit field to misrepresent one of these as zero -- the honest
answer is structurally part of the API, not left to documentation a caller might not read.

**Consequences:** When any of these six gets a real data model later (e.g. a PT-session model),
the fix is to move that key out of `NOT_COMPUTABLE` and add the real computation -- not to leave
the flag in place alongside a number that contradicts it. Any future analytics endpoint this
project adds for a metric with a real gap in the underlying data should follow the same pattern:
an explicit "here's what I can't tell you and why," not a silent zero.

---

## AI-13: P2's "AI Agent Architecture evolution" is typed tools on the existing executor, not a new Supervisor layer

**Context:** The master prompt describes P2's AI evolution as User -> AI Gateway -> Supervisor ->
Permission Check -> Specialist Agent -> Typed Tool -> Domain Service -> DB -> Result -> AI
Response -- but P3 ("Gym Brain") separately and explicitly owns "AI Supervisor, specialist agents,
permission-aware tools, AI memory, Action Center, approval workflows." The two phases' own
descriptions overlap on "Supervisor" and "specialist agents." P2 also carries the master prompt's
largest non-AI item (Member/Revenue/Sales/Trainer-PT/Inventory intelligence), and its own explicit
instruction is "make safe engineering decisions autonomously... do not jump directly to flashy AI
UI."

**Decision:** Read P2's AI item as "typed, permission-aware tools reaching real intelligence,"
not "build the Supervisor/multi-agent orchestration layer." Added 5 new tools
(`get_revenue_summary`, `get_at_risk_members`, `get_sales_funnel`, `get_trainer_workload`,
`get_inventory_forecast`) to the *existing* `ToolExecutorService` from P0 -- each calls a real
`src/analytics/` service and is gated by `resolveAccess()`, the exact same permission-resolution
pattern the P0 fix already built and tested. No new Supervisor class, no per-tool "specialist
agent," no AI memory. This is genuinely "typed permission-aware tools" per the master prompt's own
diagram's rightmost stages (Typed Tool -> Domain Service -> DB -> Result), just not yet routed
through a Supervisor that picks which specialist handles a request -- there is exactly one
tool-calling loop today, same as P0/P1, just with 11 tools instead of 6.

**Alternatives considered:** Building a Supervisor now that dispatches to a "reporting agent" vs. a
"member-management agent," to more literally match the master prompt's diagram. Rejected: nothing
in this codebase yet needs request routing between multiple specialist toolsets -- one model with
11 well-scoped tools handles every case P1/P2 produced. Building multi-agent orchestration with
nothing that actually requires it is exactly the "flashy AI UI before the operational foundation"
the master prompt warns against, and P3 already explicitly owns this work under its own name.

**Consequences:** P3's "Gym Brain" work starts from an 11-tool, single-loop foundation, not zero --
the Supervisor P3 builds should dispatch to specialist agents that reuse these same typed tools
(and `resolveAccess()`), not duplicate them. Any P2/P3-boundary tool added between now and P3
should keep going through `ToolExecutorService` the same way, until the day a real Supervisor
exists to route to.

---

## AI-14: `validateToolArgs()` disables class-validator's `forbidUnknownValues` guard

**Context:** Adding the first genuinely argument-less AI tool (`get_revenue_summary` and 4 others,
each taking `{}`) needed an `EmptyArgsDto` with zero validation decorators. Calling
`validateToolArgs(EmptyArgsDto, {})` threw `BadRequestException: Invalid tool arguments: an
unknown value was passed to the validate function` -- traced to class-validator's
`forbidUnknownValues` option (`true` by default, independent of `forbidNonWhitelisted`), a
built-in safeguard that rejects validating any class with zero registered decorators outright, on
the theory that a decorator-free class is probably a mistake, not an intentional "nothing to
validate" DTO.

**Decision:** Added `forbidUnknownValues: false` to the single shared `validateSync()` call in
`validate-tool-args.ts`. Confirmed safe for every existing tool DTO by reading class-validator's
own source (`ValidationExecutor.execute()`): the guard only fires when a class has *zero* matched
validation metadata, which none of the other 6 tool-argument DTOs do (they all have real
`@IsString()`/etc. decorators) -- so this change has no effect on their behavior. `whitelist` +
`forbidNonWhitelisted` (unaffected by this option) still correctly reject an unexpected property on
an empty-args tool call, verified by a dedicated test (`test/ai.e2e-spec.ts`,
"rejects unexpected arguments on a no-arg tool").

**Consequences:** Any future argument-less tool can keep using `EmptyArgsDto` without hitting this
again. If a future DTO is ever added with genuinely zero decorated properties for some other
reason, it will also skip this particular class-validator guard -- acceptable, since
`forbidNonWhitelisted` remains the operative protection against unexpected model-supplied
arguments in every case that matters.
