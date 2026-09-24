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

---

## AI-15: The Action Center's approval step re-checks the approver's own resource permission -- `ai.approve` is necessary but not sufficient

**Context:** P3 introduces the first AI tools that perform a genuinely consequential write (plan
assignment) rather than an inert draft. The master prompt's own diagram gates this behind
`ai.approve`, a permission already reserved (but unused) since P0. The naive reading is "grant
`ai.approve` to whoever should be allowed to approve AI proposals, gate the approve endpoint on it,
done." That reading has a hole: `ai.approve` alone says nothing about whether the approver is
actually allowed to perform the *specific* action being approved. A user who holds `ai.approve` but
not `workouts.assign` could otherwise approve an AI's proposal to assign a workout plan -- an action
they could never take directly over `POST /workout-plans/:id/assign` -- which is exactly the kind of
indirect permission bypass the master prompt's "AI must never bypass existing permissions" rule
exists to prevent. The bypass is real regardless of the AI being involved at all: the AI only chose
*which* plan to propose; the approver is the one actually causing the assignment to happen.

**Decision:** `AiActionsController` gates every route on `ai.approve` (can this user interact with
the Action Center at all), but `AiActionsService.approve()` independently re-checks, via
`PermissionsService.hasPermission()`, that the *approving* user also holds the REST-equivalent
resource permission the proposed action needs (`REQUIRED_PERMISSION` map: `ASSIGN_WORKOUT_PLAN` ->
`workouts.assign`, `ASSIGN_DIET_PLAN` -> `nutrition.assign`) -- before executing anything, and
rejecting with `ForbiddenException` if not. `ai.approve` means "can decide on AI proposals";
performing the underlying action still needs the underlying permission, exactly as it would over
REST. The approving user (not the proposing AI, and not whoever the AI acted on behalf of) is
recorded as the actor on the resulting `WorkoutAssignment`/`DietAssignment`, since they are the real
actor -- the AI only drafted a suggestion.

**Alternatives considered:** Granting `ai.approve` only to roles that already hold every
"approvable" resource permission, so the extra check would be redundant. Rejected: this couples
`ai.approve` to the *current* set of proposal types, silently breaking (or requiring a manual role
audit) the moment a new `AiActionType` is added for a resource permission not every `ai.approve`
holder has. An explicit per-type re-check is self-maintaining -- add a case to `REQUIRED_PERMISSION`
and the guarantee holds for the new type automatically.

**Consequences:** Every future `AiActionType` must add an entry to `REQUIRED_PERMISSION`
(`ai-actions.service.ts`) before it can be approved at all -- there is no default-allow path. Tested
end-to-end in `test/ai-actions.e2e-spec.ts` using an `ACCOUNTANT`-role user granted `ai.approve` via
a direct `UserPermissionOverride` (mirroring `test/permission-override-precedence.e2e-spec.ts`'s
pattern) but lacking `workouts.assign` -- confirmed the approval is rejected despite holding
`ai.approve`.

---

## AI-16: AI memory persists natural-language turns only; tool-call mechanics are auxiliary metadata, never replayed

**Context:** P3 requires real conversation memory (the master prompt's "AI memory" item), replacing
v1's client-resent `history` array. The design question was granularity: what exactly gets
persisted and fed back into a future prompt as "prior context"? The full mechanics of a past
exchange include the model's raw tool-call requests and each tool's raw JSON result, not just the
natural-language reply the user saw.

**Decision:** `AiMessage.content` stores only the human-readable USER message or ASSISTANT reply.
Tool-call information (`{name, args}[]`) is stored as auxiliary `toolCalls Json?` metadata on the
ASSISTANT message, kept so a human can view a full transcript (`GET /ai/conversations/:id`) but
never fed back into `messages[]` when `AiService.chat()` rebuilds the prompt for a later turn --
`AiConversationsService.getHistory()` selects only `role`/`content`. A future turn sees "the
assistant told the user X," not a replay of exactly which tools ran to produce X.

**Alternatives considered:** Persisting and replaying the full tool-call/tool-result sequence, so a
later turn could see precisely what data was already fetched (potentially saving a redundant tool
call). Rejected for this pass: it roughly doubles the token cost of every reloaded conversation,
raw tool results often contain the same PII-minimized-but-still-detailed data the read tools already
took care to summarize (see `src/ai/README.md`'s "Read tools return summaries" note) with less
reason to keep resurfacing it turn after turn, and nothing in the master prompt's P3 scope actually
requires this depth -- "AI memory" means the assistant remembers what was discussed, not that it
must avoid ever re-querying data it already looked up once.

**Consequences:** A tool that was called in an earlier turn may be called again in a later one if
the model decides it needs that data again -- an accepted, minor cost. If a future need appears for
genuine tool-result caching across turns, it should be a separate, explicit cache keyed by
conversation, not a change to what `AiMessage` persists as conversational content.

---

## AI-17: P3's "Supervisor" and "global AI command interface" are explicitly not built this phase

**Context:** The master prompt's P3 ("Gym Brain") scope names "AI Supervisor, specialist agents...
global AI command interface" alongside the items actually built this phase (Action Center, AI
memory). Two of these were deliberately not attempted, and the master prompt's own rule --
"make safe engineering decisions autonomously; stop only for destructive/irreversible decisions,
unavailable credentials, paid services or genuinely ambiguous business rules" -- requires explaining
why, not silently dropping them.

**Decision:**
1. **No multi-agent Supervisor.** As already reasoned in AI-13 for P2's tool additions: there is
   still exactly one tool-calling loop, now with 14 tools (6 v1 + 5 P2 intelligence + 3 P3: 1
   aggregation, 2 propose-only). Nothing built across P0-P3 has ever needed *routing* between distinct specialist
   toolsets -- one model with a well-scoped, permission-gated tool list has handled every case. A
   Supervisor that dispatches between "agents" with nothing requiring the dispatch would be
   unverifiable scaffolding, which is exactly the "flashy AI UI before the operational foundation"
   the master prompt warns against. This is a scope decision, not a limitation discovered by
   trying and failing.
2. **No "global AI command interface."** This item is a frontend/UI concern (a command palette or
   omnipresent chat surface reachable from anywhere in the app) -- this entire session, across all
   of P0-P3, has worked exclusively in the `mygymagent-b` backend repo, and building it belongs in
   `mygymagent-f`. Nothing on the backend blocks it: `POST /ai/chat` (now with `conversationId`)
   plus `GET /ai/conversations` already provide everything a frontend surface needs -- send a
   message from anywhere in the app, resume any past conversation -- without further backend work.

**Alternatives considered:** Building a minimal Supervisor now (e.g., a single `route()` function
that always picks the one existing toolset) purely to have the shape present for later phases.
Rejected: a router with one possible destination is not a real architectural decision, just an
unnecessary layer of indirection with no behavior difference -- it would need to be redesigned
anyway once a second toolset actually existed to route to.

**Consequences:** If a genuinely distinct specialist toolset need ever arises (e.g., a
finance-specific agent with tools too specialized to belong in the general chat's allowlist), that
is the trigger to build a real Supervisor -- not before. The global command interface is frontend
work with no backend dependency remaining; it can be picked up independently, in `mygymagent-f`,
whenever frontend work on this project resumes.

---

## AI-18: The Owner Daily Briefing is a read-only aggregation service, not a new intelligence source

**Context:** P3's last buildable item is the "owner Daily Briefing." P1/P2 already built five
separate real intelligence computations (`FinanceService`, `MemberIntelligenceService`,
`SalesIntelligenceService`, `TrainerIntelligenceService`, `InventoryIntelligenceService`), each
behind its own `GET /analytics/*` endpoint and `get_*` AI tool. The question was whether "Daily
Briefing" means a sixth, independent computation, or something else.

**Decision:** Built `src/briefing/DailyBriefingService.getDailyBriefing()` as pure aggregation:
it calls the five existing services (in parallel, via `Promise.all`) plus
`AiActionsService.countPending()` for the Action Center backlog, and a single direct
`prisma.attendance.count()` for today's check-ins (the one number genuinely "daily" rather than
"this month" or "current snapshot," and too trivial to warrant a sixth service). No new
computation is introduced, and every existing `notComputable` disclosure
(`RevenueSummary.notComputable`, `TrainerIntelligence.notComputable`) is passed through verbatim
in the aggregated response rather than summarized away -- an owner reading the briefing gets the
same honesty guarantee as someone reading the underlying reports directly. Exposed both as
`GET /briefing/daily` (`reports.view`, same tier as the underlying data) and as a `get_daily_briefing`
AI tool (empty args, `resolveAccess()`-gated on `reports.view`, same pattern as the other 5
`get_*` tools), so both a dashboard and the assistant can present it.

**Alternatives considered:** Generating a narrative/prose summary of the numbers server-side (an
actual LLM call baked into the briefing endpoint). Rejected: the assistant's existing
`get_daily_briefing` tool call already produces exactly that narrative when a user asks for it
through `/ai/chat` -- adding a second, server-side text-generation path for the same data would
duplicate cost and complexity for no capability gain, and would risk the "Do not fake features,
AI" rule if that second path were ever built as a canned/templated string rather than a real
model call. The REST endpoint stays structured JSON; turning it into prose is what the chat
interface is already for.

**Consequences:** Any future report this project adds that's "a view over data that already has
its own endpoint" should follow the same shape: a thin aggregation service that calls the real
per-domain services in parallel and passes their `notComputable` arrays through, not a
re-implementation of their queries. `DailyBriefingController`/`DailyBriefingService` have no
model of their own beyond what `Promise.all` composes at request time -- there is nothing here to
keep in sync with schema changes in the underlying domains beyond what those domains' own services
already handle.

---

## AI-19: TOTP second factor is opt-in per user, with the challenge carried by a non-`access` JWT

**Context:** B-P0-4 -- the platform handles payment and accounting data but had no second
factor anywhere. Adding one raises four decisions that are easy to get subtly wrong, so they are
recorded here rather than left implicit in the code.

**Decision 1 -- the challenge is a short-lived JWT typed `mfa`, not an `access` token.** When a
password check succeeds but a factor is still owed, `login` returns `{mfaRequired, mfaToken}` and
issues no session and no refresh cookie. The token's payload is `{sub, type:'mfa'}`, and
`JwtStrategy.validate()` already rejects any payload whose `type` is not `access` -- so the
challenge token cannot be presented as a bearer credential. That single pre-existing line is what
makes this design safe, so `test/auth-mfa.e2e-spec.ts` pins it with a test that tries exactly that
bypass. The token is deliberately *not* stored server-side: on its own it authorizes nothing, and
the code it must be paired with is itself replay-protected.

**Decision 2 -- the accepted TOTP step is recorded, so a code cannot be replayed.** A code stays
valid for its whole 30-second step (plus a +/-1 drift window). Without a marker, a code observed
in transit is replayable for the remainder of that window. `UserMfa.lastUsedStep` stores the
absolute step that was accepted and anything at or below it is refused. A real consequence worth
knowing: two *successful* verifications genuinely cannot happen inside one 30s window -- that is
the guard working, and the e2e suite documents it rather than weakening the window to dodge it.

**Decision 3 -- failed codes share the password lockout budget.** `MAX_FAILED_LOGIN_ATTEMPTS` /
`LOCKOUT_DURATION_MS` are now exported from `auth.service.ts` and reused by `MfaService`. A
6-digit code is a keyspace of one million with a window that accepts three codes at any instant;
unlimited guessing against a known-good password would make the second factor decorative. Reusing
the existing counter (rather than adding a parallel one) means a mixed password/code attack
against one account can't get two independent budgets.

**Decision 4 -- enrolment is opt-in per user; nothing yet *requires* it.** The master prompt's
framing ("at minimum for OWNER/ADMIN/ACCOUNTANT") could be read as "force these roles to enrol."
Forcing enrolment is a rollout decision, not a code one: switched on for an existing org it locks
every privileged user out of their own account until they complete a setup flow that, today, has
no frontend. So this phase ships the *capability* -- enrol, verify, recover, disable -- and leaves
the policy switch to B-P0-10, which needs a grace period, an admin-visible enrolment report, and
the UI in `mygymagent-f` first. Shipping backend-first is safe precisely because it is opt-in: no
existing user's login changes until they choose to enrol.

**Alternatives considered:**
- *Hand-rolling RFC 6238 on `node:crypto`.* Rejected. The HMAC itself would come from the stdlib,
  but the drift window, base32 handling and constant-time comparison are exactly the details that
  make hand-rolled auth crypto go wrong, and `otplib` is the standard, audited choice. This is the
  one place where "no new dependency" (AI-9's instinct) loses to "don't hand-roll auth crypto."
- *Storing the TOTP secret in a `User` column.* Rejected in favour of a separate `UserMfa` table:
  a `disable` deletes the row and cascades the recovery codes with it, so nothing decryptable
  survives, and the secret never rides along on the `User` row that most queries already select.
- *A second envelope format for the secret.* Rejected -- `mfa-secret.vault.ts` deliberately mirrors
  `whatsapp-token.vault.ts`'s `v1.<iv>.<tag>.<cipher>` AES-256-GCM shape. One reviewed format is
  easier to reason about than two. It is a separate module and a separate key (`MFA_TOTP_KEY`)
  because the blast radius differs: a leaked WhatsApp token lets an attacker send messages, leaked
  TOTP secrets defeat every second factor at once.

**Consequences:** `MFA_TOTP_KEY` joins the set of env vars whose absence degrades a feature to a
clear 503 rather than failing boot (same pattern as `WHATSAPP_TOKEN_KEY`). Rotating or losing it
makes every enrolled secret undecryptable -- users must re-enrol; hashed recovery codes are
unaffected and keep working, which is the intended escape hatch. Any future second factor (WebAuthn,
SMS) should reuse the same `login` -> challenge -> `/auth/mfa/verify` shape rather than adding a
second login branch.

---

## AI-20 -- Enforcing the second factor on privileged roles (B-P0-10)

**Context:** AI-19 shipped TOTP as an opt-in capability and explicitly deferred the policy,
naming what the policy would need first: a frontend enrolment flow, an admin-visible enrolment
report, a grace period, and only then a hard requirement for `ORG_OWNER` / `ORG_ADMIN` /
`ACCOUNTANT`. The frontend flow landed as F-P0-4. This is the rest.

**Decision 1 -- enforcement issues a confined session; it never refuses the login.** This is the
whole design. Enrolling requires an authenticated session, and login is the only way to get one,
so refusing an unenrolled privileged user's login locks them out of the single screen that would
fix it -- permanently, with no self-service path back. Instead the login succeeds, and
`MfaEnrolmentGuard` (global, registered immediately after `JwtAuthGuard` and *before*
`PermissionsGuard`) rejects every route the session touches except the ones wearing
`@AllowPendingMfaEnrolment()`: `GET /auth/me`, `POST /auth/logout-all`, and the three enrolment
routes. Deny-by-default matters here -- forgetting to decorate a new route makes it *less*
reachable from an under-protected account, never more.

**Decision 2 -- the restriction is recomputed per request, not carried in the token.**
`JwtStrategy` already re-reads the user on every request so suspensions and role changes take
effect immediately rather than waiting out a 15-minute access token; the policy check rides along
on that same lookup, with the organization's two policy columns joined into the existing `select`.
The payoff is that finishing enrolment lifts the restriction on the very next call, with no token
rotation and no re-login. The cost is one extra query per request -- but only for organizations
that actually switched enforcement on, because `MfaPolicyService.isEngaged()` short-circuits on a
field comparison for everyone else.

**Decision 3 -- two policy values plus a date, not three policy values.** A separate `WARN` state
would be a setting an admin could leave switched on for a year believing it protected them. So
`MfaPolicy` is `OPTIONAL | REQUIRED_FOR_PRIVILEGED`, and the staged rollout is expressed by
`REQUIRED_FOR_PRIVILEGED` *plus* a future `mfaGraceUntil`: the same setting that warns today
enforces by itself later, with no second action required to finish the job. Switching enforcement
on without naming a date grants 14 days rather than restricting everyone the same second;
enforcing immediately stays possible (an incident is a real reason to) but must be asked for with
an explicit `graceUntil: null`. Re-saving an already-enforcing policy keeps the existing deadline,
so a policy cannot be kept perpetually toothless by touching the settings page. Turning the policy
off clears the date, because a stale past deadline would make the next enable bite with no warning
at all.

**Decision 4 -- these are typed columns, not keys in `Organization.settings`.** Login reads them
on every password check and `JwtStrategy` on every authenticated request. That is not a place for
an unmanaged JSON blob, and it matches the reasoning already recorded on `emailFromName`.

**Decision 5 -- the enrolment report is gated on `organizations.update`, not `users.read`.** It is
a list of exactly which privileged accounts are unprotected. In the wrong hands that is target
selection; its only legitimate use is deciding this organization's policy, which is the same
audience. `BRANCH_MANAGER` holds `users.read` and is deliberately excluded.

**Decision 6 -- `BRANCH_MANAGER` is not a covered role.** It cannot change organization settings
or reach accounting, and sweeping it in would multiply the rollout's lockout surface for little
gain against the payment/accounting exposure that motivated the work.

**Consequences:** an organization that never opts in is byte-for-byte unaffected -- the migration
defaults every existing tenant to `OPTIONAL`. `mfaEnrolment: { state, deadline }` now rides on the
login response *and* `/auth/me`; the latter matters because a deadline a user sees exactly once is
not a warning. A covered user who loses their authenticator after enforcement begins still has
recovery codes (AI-19); if those are gone too, the escape hatch is an admin moving the policy back
to `OPTIONAL`, which is itself audited -- there is deliberately no per-user exemption, because a
per-user exemption list is a policy that erodes silently.

---

## AI-21 -- One table of record for device check-in (B-P0-5)

**Context:** the backlog described two independent, never-reconciled device check-in mechanisms:
`devices.controller.ts` (branch `deviceKey` + `DeviceMap`) and Business OS's kiosk endpoints
(`kiosk_devices` / `kiosk_events`). Reading them showed the situation was worse than "two systems
that disagree" -- neither worked end to end:

- The kiosk path evaluated the gate correctly but wrote **only** a `kiosk_events` row, and nothing
  in the codebase ever read that table. A member who checked in at a kiosk appeared in no
  attendance list, no report and no live turnstile view, and raised no `AttendanceRecorded` event,
  so none of the notifications that hang off attendance fired.
- `DevicesController` was declared in **no module**, so `/devices/check-in` did not exist at
  runtime -- while the branches UI hands admins a device key to point a scanner at.
- `AttendanceMethod.KIOSK` existed in the enum and was never written by anything, which is the
  clearest possible statement of what the original design intended.
- The kiosk's "member not found" branch wrote a `kiosk_events` row containing the *unverified*
  member id. That column is a foreign key, so an unknown id raised a constraint violation: a
  wrong member number at a kiosk returned 500 instead of a decision the screen could display.

**Decision 1 -- `Attendance` is the single table of record; `kiosk_events` is gone.** Device
attribution was the only thing `kiosk_events` held that `Attendance` did not, so `Attendance`
gains a nullable `deviceId`. The migration backfills the surviving kiosk history into
`attendances` before dropping the table: rows with a real member become `KIOSK` attendance rows at
their original timestamp. A denied row gets an explicit marker rather than a fabricated reason,
because the old table recorded `result` but never *why* the gate refused.

**Decision 2 -- `deviceId` is `SetNull`, not `Cascade`.** Decommissioning a kiosk must not delete
the attendance history it recorded. This is the same reasoning as `recordedByUserId`.

**Decision 3 -- one writer, `recordDeviceCheckIn()`.** Both device paths now go through it, so a
kiosk row and a turnstile row are indistinguishable to every reader except for the method and the
device. Two call sites writing `Attendance` with slightly different rules is how these drifted
apart in the first place; the gate decision was already shared via `evaluateGate()`, but the
*write* was not.

**Decision 4 -- the kiosk moves into the attendance module, keeping its URLs.** A kiosk check-in
is an attendance record, so it belongs beside the rest of attendance rather than in Business OS.
The routes stay at `/kiosk/*` so deployed kiosks and the `/kiosk` page need no change.

**Decision 5 -- `/kiosk/check-in` now answers 200 and 401 like `/devices/check-in`.** It used to
answer 201 for a decision and 400 for a bad key. An unattended device treats a non-200 as a
failure worth retrying, and an invalid credential is an authentication failure, not a malformed
request. Aligning the two ingest endpoints is the point of the exercise. The one cost is that the
public `/kiosk` page's API client fires a futile `/auth/refresh` on a 401; it fails fast and does
not loop, and suppressing it would break session restore on page load, which legitimately depends
on refreshing with no access token in memory.

**Decision 6 -- the DB-backed rate limiter moves to `PublicRateLimitService`.** It was a private
method on `BusinessOsService`, and the kiosk endpoint needed it after moving. These endpoints are
hit by unauthenticated devices from the open internet, so the window has to hold across every
application instance -- `@Throttle()` alone is per-process, and now sits on top as a cheap first
line rather than the only one.

**Not done, deliberately:** the biometric path is now *reachable* but still cannot succeed --
`DeviceMap` has no write endpoint, so every call resolves to "unenrolled device user" (B-P1-8).
And `Branch.deviceKey` remains a single plaintext secret shared by every scanner on a branch,
where `KioskDevice.keyHash` is per-device, hashed and revocable (B-P0-13). Both are missing
features rather than reconciliation problems, and folding them in here would have buried the
change that matters.

**Consequences:** a kiosk check-in now fires `AttendanceRecorded`, so it reaches the notification
fan-out exactly as a front-desk check-in does -- gyms running kiosks will start seeing attendance
notifications they never got before. Reports and the live view gain whatever kiosk history the
backfill recovered.

---

## AI-22 -- No implicit type coercion at the API boundary (B-P0-7)

**Context:** `main.ts` set `transformOptions: { enableImplicitConversion: true }` on the global
`ValidationPipe`. class-transformer's implicit boolean conversion is `Boolean(value)`, under which
every non-empty string is `true` -- including the strings `"false"` and `"0"`. A client sending
`{"inApp": "false"}` to opt *out* of a notification category was silently opted *in*, and
`@IsBoolean()` never saw a value it could reject, so nothing 400'd. This is the same bug class
AI-7 already fixed once for `SMTP_SECURE`. B-P0-2 patched the five notification fields with a
local `RawBoolean()` transform; 18 `@IsBoolean()` fields elsewhere still had the hole.

**Decision 1 -- remove the option globally rather than patch field by field.** A per-field fix
leaves the trap armed for every DTO written afterwards: the default stays wrong and each new
boolean field is one forgotten decorator away from inverting its own meaning. Removing the option
makes the safe thing the default and the unsafe thing impossible to reach by accident. The cost is
real -- it is the one change in this codebase that can break any endpoint at once -- and is paid
once, under test, rather than owed indefinitely.

**Decision 2 -- `@ToBoolean()` is for query DTOs only, and refuses to guess.** A query string is
text by construction, so `?overdue=true` genuinely needs converting. A JSON body carries real
types, so a string there is a client bug that plain `@IsBoolean()` should reject -- adding the
transform to a body field would quietly accept `{"isTrainer": "false"}`, which is leniency of the
same family as the original bug, just pointing the other way. (This distinction was not obvious
in advance: the first draft put `@ToBoolean()` on `isTrainer`, and the regression suite caught it.)
Within query DTOs the helper converts only `true`/`false` and their case-insensitive string forms
and passes everything else through to `@IsBoolean()`, so `"1"`, `"yes"` and `"nope"` each earn an
explicit 400. The alternative spelling `value === 'true'`, which `ListInvoicesQueryDto` used, maps
anything unrecognised to `false` and so turns a typo into a silent wrong answer.

**Decision 3 -- `@Type(() => Boolean)` is banned, not merely discouraged.** It applies the same
`Boolean(value)` and had exactly the same effect on the two fields carrying it
(`CreateUserDto.isTrainer`, `ListProductsQueryDto.isActive`) -- removing the global option would
not have fixed those. `InventoryQueryDto.activeOnly` carried it too, which meant
`?activeOnly=false` filtered to active rows only: a caller explicitly asking to see everything was
silently shown a subset and had no way to tell.

**What the removal broke, and how it was found.** Every `@IsDate()` field on a *body* DTO was
relying on implicit conversion: JSON has no date type, so a client sends an ISO string, and
without `@Type(() => Date)` every one of them becomes a 400. `PtSessionsController` had **no e2e
coverage at all**, so the full 333-test suite passed while PT session booking was completely
broken. It was caught by auditing `@IsDate()` occurrences by hand rather than by trusting a green
suite, and `test/pt-sessions.e2e-spec.ts` now exists so the next person is not so lucky. The
lesson worth recording: for a change with this blast radius, a passing suite is evidence about the
tests, not about the code.

**Decision 4 -- numeric *body* fields were deliberately left without `@Type(() => Number)`.** 67 of
them have none. Unlike the boolean case this is not dangerous -- `Number("abc")` is `NaN` and
`@IsNumber()` rejects it, so there is no silent inversion -- but it is a real behaviour change: a
client that sends `{"price": "500"}` in a JSON body now gets a 400 where it previously succeeded.
Adding the decorator everywhere would have prevented that at the cost of 67 fields of churn and of
reinstating "the API guesses at your types", which is the philosophy this change removes. The
frontend coerces client-side already (`z.coerce.number()` in 25 places in `lib/validation/gym.ts`),
so it sends real JSON numbers, and the e2e suite exercises these paths. Any *other* API consumer
sending stringified numbers in a body is the group this affects.

**Consequences:** `test/validation-coercion.e2e-spec.ts` pins the property from both ends -- that
wrong input is rejected, and that `false` actually means false where it is observable -- and turns
red if the option or `@Type(() => Boolean)` comes back. New DTO fields now follow one rule: body
fields validate the real JSON type and nothing else; query fields convert explicitly with
`@Type(() => Number)`, `@Type(() => Date)` or `@ToBoolean()`. `test/utils/test-app.ts` must keep
mirroring `main.ts`'s pipe exactly, or the suite would validate a configuration production does
not run.

## AI-23 -- One device registry, keys stored only as digests (B-P0-13)

**Context:** the biometric turnstile (`POST /devices/check-in`) authenticated against
`Branch.deviceKey`: a single nullable, unique, **plaintext** column on the branch. One secret was
therefore shared by every scanner on a branch — a compromised device could only be dealt with by
re-keying all of them, and the key sat readable in the row. Meanwhile the kiosk, reconciled in
AI-21, already had the right shape: `KioskDevice`, one row per device, key stored only as a sha256
digest.

Auditing it turned up more than the backlog claimed. Nothing in the API ever *wrote*
`Branch.deviceKey` — the frontend's branches page called `POST /branches/:id/rotate-device-key`,
which has never existed server-side. So the column is NULL in every deployment, the turnstile route
could not authenticate at all, and the "Rotate" button on the branches page always failed. The
security defect and a dead feature were the same defect.

**Decision:** `Branch.deviceKey` is dropped. `KioskDevice` becomes the registry for every device
that records attendance without a staff login, carrying a `DeviceKind` (`KIOSK` | `BIOMETRIC`) and
a `revokedAt`. Both ingest routes resolve a presented key through one private `resolveDevice(key,
kind)`: a lookup by digest on the unique index, filtered by kind and `active`.

**Consequences:**

- `kind` is part of the *lookup*, not a check afterwards. A kiosk key presented at the turnstile
  finds no row — the same 401 as a key that was never issued — so neither route can be used to
  probe the other's registry. This matters because the two judge a check-in differently: the kiosk
  requires the member's primary branch to match, the turnstile resolves an external id through
  `DeviceMap`. A key that worked on both would silently change the rules a member is admitted under.
- Registration, listing and revocation moved from `POST /kiosk/devices` to `/devices`, so there is
  one registry with one management surface. `/kiosk/check-in` keeps its path: deployed kiosks call
  it, and nothing about the credential changed for them.
- Revocation deactivates, it does not delete. `Attendance.deviceId` is `SetNull`, so deleting a
  device would erase the attribution of every check-in it recorded.
- The listing never selects `keyHash`. A digest has no reason to leave the database, and a listing
  endpoint is exactly where one leaks by accident; a test asserts it.
- Turnstile check-ins now carry `deviceId`. With one key per branch there was no device to name, so
  every biometric row was written with a null `deviceId` even though the column existed.
- The migration backfills one `BIOMETRIC` device per branch that carries a key, hashing it with
  `encode(sha256(...), 'hex')` — byte-identical to the application's `sha256Hex` — so a scanner
  already configured with a branch key keeps authenticating. Verified against a scratch database
  seeded with a keyed branch, a keyless branch and a soft-deleted keyed branch: one row, the right
  digest, the soft-deleted branch skipped.
- **Still open:** `DeviceMap` has no write path (B-P1-8), so a turnstile cannot be *enrolled*
  through the API even now that it can authenticate. This ADR fixes the credential, not the
  enrolment.

## AI-24 -- Group training on typed Prisma, and one lock per session (B-P0-8)

**Context:** `src/classes/classes.service.ts` reached `class_programs`, `class_sessions` and
`class_bookings` exclusively through `$queryRawUnsafe`, and none of the three had a `model` block.
Unlike the Business OS case in AI-1/B-P0-1, the SQL quoted its camelCase columns correctly, so it
genuinely worked — B-P0-2's suite proves the capacity, waitlist and promotion behaviour is sound.
The cost was that nothing type-checked a column name, and `prisma migrate diff` could not see three
tables at all, so they were invisible to the drift work in B-P0-12.

**Decision:** model all three, and port the service to the typed client.

**Consequences:**

- The models describe the *physical* tables rather than what Prisma would have generated. Constraint
  and index names are pinned with `map:` (`class_programs_org_fkey`,
  `class_bookings_unique_member_session`, …), and every relation carries `onUpdate: NoAction`
  because the hand-written DDL omitted the ON UPDATE clause that Prisma defaults to `CASCADE`.
  Without that, modelling the tables would have *added* drift rather than removing it. Measured:
  zero `class_*` lines in `migrate diff`, and total drift 475 → 427.
- Two aggregate reads (`sessions`, `analytics`) become a typed read plus one `groupBy`, because
  `COUNT(...) FILTER (WHERE ...)` has no `include` equivalent. The response shapes are unchanged.
- The instructor filter on `sessions` stays in application code: it is
  `COALESCE(session.instructorId, program.instructorId)`, which is not a `where` on either column.
- **One real defect surfaced.** `book()` serialised on `pg_advisory_xact_lock(session)`; `cancel()`
  used `SELECT ... FOR UPDATE` on booking rows. Those lock different objects, so the two did not
  exclude each other, and a cancellation promoting the head of the waitlist while a booking was
  counting places could put a session over capacity. `cancel()` now takes the same session lock.
  Row locks also have no typed Prisma equivalent, so the fix and the port were one edit.
- `updatedAt` is maintained by Prisma (`@updatedAt`) instead of being written into every UPDATE by
  hand. The column keeps its `DEFAULT CURRENT_TIMESTAMP`, so the schema still matches the DDL.
- Concurrency tests are in the suite, and they are honest about being probabilistic: with the lock
  removed the six-way booking race reddened on every run, the cancel-versus-book race on one in
  five. A race that only sometimes reproduces is still a race.

## AI-25 -- Schema drift is resolved on the side that is wrong, and then enforced (B-P0-12)

**Context:** `prisma migrate diff --from-migrations --to-schema-datamodel` printed 475 lines. It had
been that way on both `main` and this branch, unchanged, for long enough that nobody could say which
side was correct — which is exactly the state in which drift stops being cosmetic.

**Decision:** treat "the database is wrong" and "the model describes the database badly" as two
different problems with two different remedies, and never conflate them.

- **The model describes the database badly** — a constraint or index name, a missing `ON UPDATE`, a
  DB-side `gen_random_uuid()` or `CURRENT_DATE` default, a primary key the model declared only as
  `@unique`. Here the physical table is the truth: every deployment was built by these migrations.
  Annotate the model (`map:`, `onUpdate: NoAction`, `@default(dbgenerated(...))`, `@id`). No DDL
  runs, so nothing can break. This was ~385 of the 475 lines.
- **The database is genuinely missing something** — resolve with a migration. This was the other
  ~90 lines, and **every single item in it was a live defect**:
  - `AutomationKey` had no `PT_EXPIRY_REMINDER`, a value `pt-expiry.scanner.ts` already writes.
  - `trainer_availability_rules` and `trainer_time_offs` were declared in the schema and created by
    no migration. `appointments.service.ts` queried them in thirteen places, so seven routes failed
    at runtime in every deployment.
  - `member_tag_assignments` had no foreign keys at all, against four declared with cascades.
  - `payments.branchId` was NOT NULL with `ON DELETE CASCADE` where the model says nullable with
    `SET NULL` — deleting a branch deleted its payment history.
  - `payments.stripePaymentIntentId` was `@unique` in the model and had no index in the database,
    so nothing stopped a replayed Stripe webhook recording the same payment twice.

**Consequences:**

- Drift is 0 and `npm run db:check-drift` keeps it there, in CI, before the tests run. It diffs
  against a database built *from the migrations* in a throwaway shadow database, which is the only
  form of the check that catches a schema change committed without its migration; diffing against
  an already-migrated dev database would not. Verified in both directions.
- The script's header carries the decision rule above, because the next person to hit a red drift
  check needs it more than they need the command.
- The lesson generalises past Prisma: **a schema is a claim about a database, and only a request
  proves it.** `TrainerAvailabilityRule` looked entirely healthy in `schema.prisma`, type-checked
  everywhere it was used, and had no table. The new `test/appointment-availability.e2e-spec.ts` is
  end-to-end rather than a schema assertion for exactly that reason — a test that checks a table
  exists would pass against a table nothing can use.
- The appointments module having had no e2e suite at all is what let seven broken routes sit there.
  That pattern now has a name in this file: it is the same finding as AI-22 (a passing suite is
  evidence about the tests, not the code) and the same as B-P0-5/B-P0-6, where every module that
  turned out to be broken also turned out to have no caller and no test.

## AI-26 -- Enrolling a member on a turnstile is an attendance privilege, not a device one (B-P1-8)

**Context:** `DeviceMap` maps a scanner's own identifier for a person to a member, and nothing in
the codebase ever wrote one — no endpoint, no import, no seed. Every biometric check-in therefore
answered `{allowed:false, reason:"unenrolled device user"}`, in every deployment, forever.

This was the third and last missing piece of the same feature. The route did not exist until B-P0-5
registered a controller that had been declared in no module; the device had no credential it could
present until B-P0-13 found that `Branch.deviceKey` had no write path either; and the person could
not be enrolled until now. Three separate audits, three missing writers, one feature that had never
worked end to end.

**Decision:** put enrolment under `/attendance/enrolments`, gated on `attendance.create*`.

**Consequences:**

- The permission split is the substance of this ADR. `kiosk.manage` administers the **hardware** —
  register a device, revoke a device (AI-23) — which is branch-manager work. `attendance.create*`
  decides **who may walk through the door**, which is front-desk and trainer work. An enrolment is
  the second, not the first: it is the same act as minting a QR entry credential, which AI-19/B-P0-9
  settled at `attendance.create*` after finding it had been wrongly reachable with `members.read`.
  Gating enrolment on `kiosk.manage` would have put a routine front-desk task behind a hardware
  permission, and gating device revocation on `attendance.create*` would have let every trainer
  decommission a turnstile.
- Assignment scope applies exactly as it does to the QR route: a trainer enrolling a member who is
  not theirs gets the same 404 as if the member were in another organization.
- Re-pointing an `externalUserId` at a different member is a **409, not an upsert**. Scanners reuse
  ids when someone is removed from the hardware, so an upsert here would silently transfer building
  access from one member to another on a repeated call. Removing the old enrolment first is one
  extra step and makes the handover deliberate; a test covers both halves.
- Enrolments are hard-deleted, unlike revoked devices, which are deactivated. The distinction is
  whether the row carries history: `Attendance.deviceId` points at a device, so a deleted device
  would orphan attribution, while an enrolment is only a mapping and the attendance it produced
  references the member directly.

## AI-27 -- A reconciling migration must be idempotent, because nobody has an accurate model of production (B-P0-12 follow-up)

**Context:** the migration written for AI-25 took production down. `CREATE TABLE
"trainer_availability_rules"` failed with `42P07 relation already exists`, Prisma marked the
migration failed, and every subsequent boot stopped at `P3009` — so the service would not start at
all until a human intervened.

**What I got wrong.** AI-25 verified the migration history against a database *built from the
migrations*, and reported zero drift. That check was correct and is still the right check — but it
proves the history is self-consistent, not that any particular database matches it. Production had
drifted in the opposite direction from the one I measured: the two trainer tables already existed
there, created out of band (the signature of a `prisma db push`). The whole point of B-P0-12 was
that the schema and the database disagreed, and I then wrote the fix as though the database were
exactly what the history predicted. The irony is the finding.

**Decision:** every statement in a reconciling migration converges to the intended state from
wherever the database actually starts.

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP INDEX IF EXISTS`.
- `ADD CONSTRAINT` has no `IF NOT EXISTS`, so each is written as
  `DROP CONSTRAINT IF EXISTS x, ADD CONSTRAINT x ...` in one statement. That also *repairs* a
  constraint that exists with the wrong definition, which a guard alone would skip — and a wrong
  `ON DELETE` was one of the defects being fixed.
- The one statement that can legitimately fail on real data — making
  `payments.stripePaymentIntentId` unique — fails loudly and names the offending intent ids, rather
  than surfacing as a bare `23505` or, worse, being silently skipped. Merging duplicate payments is
  a business decision; a migration may not make it.

**Consequences:**

- Verified on four databases, not one: a fresh database; a database reproducing production (history
  applied *without* this migration, then `db push` to create the tables out of band); that same
  database twice more to prove repeat runs are clean; and a database seeded with duplicate Stripe
  intent ids to prove the guard fires with a useful message. Both paths converge on an identical
  schema (1248 columns) with zero drift.
- The case-folding bug the test caught is worth recording: `to_regclass('public.payments_stripePaymentIntentId_key')`
  lower-cases an unquoted identifier and never matches an index whose name carries capitals. The
  guard has to be `to_regclass('public."payments_stripePaymentIntentId_key"')`. Writing the guard
  is not the same as knowing it works.
- **The gap that remains:** CI checks migrations against schema, which would not have caught this.
  Nothing checks a migration against a database that has drifted from the history in some third
  direction, and short of running deploys against a restored production snapshot, nothing can. The
  honest mitigation is the rule above — idempotent by construction — applied to every migration
  that touches an object it did not itself create.

## AI-28 -- Salary is an HR permission, and an incoherent one must be unsavable (B-P1-7)

**Context:** `processPayrollRun` reads `payrollEnabled`, `salaryType`, `baseSalary` and `hourlyRate`
off `StaffProfile`. Nothing in the API wrote any of them — `CreateUserDto`/`UpdateUserDto` expose
none, and no other route touched them. A payroll run on a real deployment therefore either found no
payroll-enabled staff and 400'd, or computed every payslip from nulls. The e2e suite set them
through Prisma and said so in a comment rather than pretending otherwise.

This is the fourth instance this session of the same shape: code that reads state nothing can write
(`Branch.deviceKey` in AI-23, `DeviceMap` in AI-26, two tables and an enum value in AI-27).

**Decision:** `GET /hr-payroll/staff` and `PATCH /hr-payroll/staff/:userId`, gated on `hr.read` /
`hr.manage`.

**Consequences:**

- **Not `users.update`.** The permission catalog already describes `hr.read` as covering "payroll
  settings", and the columns sit on `StaffProfile` beside leave and hire date. More decisively,
  `hr.manage` includes BRANCH_MANAGER and `users.update` does not — so bolting these fields onto
  `PATCH /users/:id`, the one-line option, would have denied the role that actually runs HR for a
  branch. Checked against `roles.catalog.ts` rather than assumed; a first pass at that check was
  wrong and the test caught it.
- **The validation is the point, not the write.** `processPayrollRun` falls back to `Decimal(0)`
  for a null rate, so an endpoint that merely exposed the columns would have moved the silent
  failure one step later: payroll enabled with no salary type, or a MONTHLY salary with no amount,
  yields a run of zero-rupee payslips that nothing flags. Those states are refused.
- **Validated against the resulting row, not the patch.** Whether a rate is required depends on the
  salary type, and whether either is required depends on `payrollEnabled` — none of which
  class-validator can see from a PATCH, because the missing half may already be stored. So the DTO
  validates shapes and the service validates coherence. Zero is refused as firmly as null, since
  `baseSalary * days` is the same zero either way.
- **The fixtures are the proof.** Both payroll suites now set salary over HTTP. A feature is only
  reachable if the tests can reach it the way a user would; while they reached past the API into
  Prisma, the suite was green and the product was unusable.

## AI-29 -- Accepting an invitation activates the account, and the portal scopes by query not by grant (F-P0-1)

**Context:** building the member portal turned up two defects, one of them severe.

**1. Nobody invited to this product could ever log in.** `POST /users` creates a staff account with
status `INVITED` and emails a set-password link; `login()` refuses anything that is not `ACTIVE`;
and *nothing in the codebase ever promoted an `INVITED` user*. So every staff member and every
member ever invited could set a password and then be told their credentials were wrong. Twenty e2e
suites flipped the status through Prisma to get past it — the same "tests reach around the API"
signature as the payroll fixture in AI-28, and the reason this survived.

`resetPassword` now activates an account that is `INVITED`, and sets `emailVerifiedAt`, because the
token went to that address and redeeming it proves control of the mailbox. **Only `INVITED` is
promoted**: a `SUSPENDED` or `DISABLED` account resetting its password stays as it is, or this
endpoint becomes a way around an account having been switched off. A test pins each half.

**2. The `MEMBER` role was a latent gym-wide read.** It carried `attendance.read`, `workouts.read`
and `nutrition.read` — the *org-wide* permissions that `GET /attendance` and friends accept. Issuing
it would have let a member list every check-in in the gym, every workout plan and every diet plan.
Nothing issued it, which is the only reason it was never a breach.

**Decision:** the portal is a separate surface that uses no RBAC permissions at all. The `MEMBER`
role's permission list is now empty.

**Consequences:**

- No `/portal` read route takes a `memberId` and none declares a permission. The member is resolved
  from the caller's own JWT through `Member.userId`, and every query is scoped to that id. "Their
  own data" is therefore a property of the query, which a later edit to a role cannot widen — the
  failure mode that made the `MEMBER` role dangerous in the first place.
- Member login reuses the staff credential lifecycle — a linked `User` with the MEMBER role, the
  same password-reset token, the same `POST /auth/login`. A parallel member-credential table would
  have meant a second password hash, a second lockout policy and a second reset flow to keep
  correct, for no gain.
- A staff account hitting `/portal/me` gets 403 rather than an empty page: it has no linked member,
  and that is a mistake worth surfacing.
- `test/utils/mailbox.ts` decodes quoted-printable declared in a *part* header, not only the
  top-level one. It previously returned an encoded body for multipart mail, where a soft-wrapped
  token (`=\r\n` mid-URL) read as half a token — indistinguishable from a legitimately invalid one.

## AI-30 -- The session says which app it opens, and the grant that opens it has a caller (F-P0-1)

**Context:** AI-29 shipped a working member portal that a member could not actually reach.

Two things were missing, and both are the same shape — a capability with no way to invoke it.

**1. The login page sent everyone to `/dashboard`.** A member landing in the staff app 403s on
every request and has no way out; the portal was reachable only by typing `/portal` into the address
bar. The client cannot work out which app a session belongs to without probing a route it expects
to be refused, so it is the server's answer to give.

**2. `POST /portal/enable/:memberId` had no caller anywhere in the UI.** The route, its permission,
its invitation email and its tests all existed, and no gym owner could grant a member a login. This
is the sixth instance of the pattern this audit keeps finding — `Branch.deviceKey`, `DeviceMap`,
the trainer-availability tables, the `StaffProfile` salary fields, `User.status = 'ACTIVE'` — where
code reads or offers state that nothing in the product can write.

**Decision:** `/auth` answers `memberId` on the user it returns, and one function decides the route.

**Consequences:**

- `publicUser()` carries `memberId: string | null`, resolved through `Member.userId`. It is
  included on login, on MFA completion, on refresh and on `/auth/me` — all four, because a reload
  must not lose the decision. E2e pins the member case, the reload case and the staff-is-null case.
- `homeRouteFor()` is the single decision, read by the login page and by the staff layout, so the
  two cannot drift apart. The staff layout redirects a member to `/portal`, mirroring what the
  portal layout already does to a staff account; neither renders its shell while redirecting, so
  there is no flash of an app the viewer cannot use.
- `completeMfaLogin()` returns the session it established rather than `void`. A member with a second
  factor has to route the same way as one without.
- `GET /members/:id` includes the member's portal login as `{ id, email, status }` — selected field
  by field, never `user: true`, because that row carries the password hash and the MFA secret. A
  test asserts the key set exactly, so widening it fails.
- Staff see three states, not two: no login, invitation outstanding (`INVITED`), and signed up
  (`ACTIVE`). They call for different words and a different button, and the distinction is only
  available because `User.status` now means something (AI-29).

## AI-31 -- The seeded catalogs converge at boot, because deploy never ran the seed (B-P0-14)

**Context:** three catalogs live in code — `PERMISSIONS_CATALOG` (98 keys), `ROLES_CATALOG` (14 system
roles and what each grants) and `DEFAULT_TEMPLATES_CATALOG` (24 message templates). `prisma/seed.ts`
was the only thing that wrote them into a database. Deploy runs `scripts/migrate-deploy.cjs` — which
applies migrations and hands off to the app — and nothing else. `tsx`, which the seed needs, is a
devDependency and is not installed in production at all.

So the seed had not run against production since someone last ran it by hand. Production was
carrying **59 of 98 permissions and 9 of 24 default templates**, and `ORG_OWNER` — defined in the
catalog as `ALL_PERMISSIONS` — held 59 grants.

Every route behind one of the 39 missing keys answered 403 **to everyone, the organization owner
included**: appointments, expenses, WhatsApp, classes, loyalty, referrals, support, feedback,
marketing, accounting, kiosk, search, HR, payroll, platform billing, data import/export — and
`portal.manage`, which gates the member-invite button shipped the day before. Essentially every
module built during this audit was inert in production while looking perfectly healthy in the code,
in CI and in every e2e suite, because all of those seed the catalogs first.

This is the same shape as AI-28's payroll fixture and AI-29's `User.status`: **the tests reach around
the thing that was broken.** Here they reached around it by seeding.

**Decision:** the catalogs converge as part of coming up, the way the schema converges via
`migrate deploy`. `syncCatalogs()` in `src/catalog/catalog-sync.ts` is the one implementation;
`CatalogSyncService` calls it from `onApplicationBootstrap`, and `prisma/seed.ts` now calls the same
function rather than carrying a second copy that could drift — which is the failure this change is about.

**Consequences:**

- It runs on every boot, so it diffs before it writes: a converged database costs a few reads and
  zero writes, and the log line only appears when something actually changed.
- The whole sync takes `pg_advisory_xact_lock` inside one transaction. Two instances of a rolling
  deploy booting together would otherwise both read "missing" and both insert.
- **Permissions are additive; system roles are authoritative.** A permission is never deleted — other
  rows reference it, and a key retired from the catalog is not a reason to drop grants underneath a
  running tenant. A system role's grant list is mirrored exactly, because the catalog *is* the
  definition of what `BRANCH_MANAGER` means. Only rows with `organizationId` null are touched, so an
  organization's own roles are never an input or an output.
- Boot fails if the sync fails. A half-synced RBAC serving traffic is precisely the failure being
  fixed, and the app cannot serve without Postgres anyway.
- A role granting a key that is not in the permission catalog throws rather than quietly producing a
  smaller role. A test asserts the two catalogs agree, so that never reaches a boot.
- `test/catalog-sync.e2e-spec.ts` (10) covers converging from a drifted database, withdrawing a
  stale grant, never deleting a permission, repairing a clobbered template, leaving organization-owned
  roles alone, idempotence, concurrent runs, and — the case that is actually the fix — that booting
  the app converges a database that was missing a key. Commenting `CatalogModule` out of `AppModule`
  turns exactly that one red.

**Also here:** members get their own invitation. `enablePortalLogin` was sending `staff_invite`
("You've been invited to join {{organizationName}} on THE CULT CLIENT"), which reads as a job offer
for software the member has never heard of. `member_portal_invite` says their gym set up their
account and what they will find in it. The send result is now reported honestly too — it was
`invited: true` regardless of whether the email went out, which is how a gym owner ends up waiting on
a message that was never going to arrive.

## AI-32 -- The member portal's write half, and what a member is not allowed to decide (F-P0-1)

**Context:** the portal could read. Booking a class, renewing, changing a phone number and muting a
notification all still meant phoning the gym.

**Decision:** the writes follow the same rule as the reads — no route takes a member id, the member
is resolved from the caller's own JWT, and every query is scoped to that id. Four things are worth
recording because they are where the obvious implementation is wrong.

**1. The narrow DTO is the authorization.** `UpdatePortalProfileDto` lists contact fields and nothing
else, so it cannot *express* a change to `status`, `primaryBranchId`, `assignedTrainerId`,
`memberType` or `email`, and `forbidNonWhitelisted` rejects the attempt. The alternative — accept the
member shape and strip the forbidden fields — puts one missed `delete dto.x` between a member and
their own membership status. A test case per field pins it. `email` is excluded specifically because
it is the login identity: changing it here would move the account without the verification the staff
flow does.

**2. Reusing the staff cancel would have been a hole.** `ClassesService.cancel` checks only that the
booking belongs to the organization, which is correct for a receptionist cancelling on someone's
behalf and wrong for a member — it would let any member cancel any other member's seat. The portal
establishes ownership from the JWT first and only then calls the shared cancel, keeping its advisory
lock and waitlist promotion. A test cancels another member's booking and asserts 404 *and* that the
seat is still booked.

**3. A member sees six notification categories, not ten.** The first cut showed the whole catalog, so
a gym member was offered switches for "low stock and inventory alerts" and "new leads" — settings for
messages that will never be sent to them. `memberFacing` now marks the six that can reach a member,
and `memberDescription` restates them from the member's side, because the staff wording ("Member
attendance activity") describes other people. A staff-only key is *refused* rather than stored, which
is B-P0-11's rule applied to this surface: a setting that changes nothing is worse than a rejection.

**4. Renewal is a request, not a payment.** Taking money needs a gateway that is actually configured
and a webhook that is actually reachable. A "Pay now" button that silently does neither is worse than
no button, so the portal prices the plans from the plan row — never from the request body, which is
the shape that matters whenever the payment half does land — and files the request as a
`MemberFollowUp`, the queue staff already work from. One open request at a time, so a double tap on a
slow connection does not queue twice. The screen says plainly that nothing is charged there.

**Also:** `GET /portal/me` returns every field the account form can edit. It previously returned a
subset, so the form rendered blanks over stored values and a member could not tell an empty field
from one the screen had not fetched.
