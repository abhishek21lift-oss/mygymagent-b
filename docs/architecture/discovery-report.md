# Architecture Discovery Report

**Scope:** honest audit of the existing `mygymagent-b` (NestJS/PostgreSQL API) and `mygymagent-f`
(Next.js frontend) codebases against the full "world-class Gym Operating System" specification, as
requested. This is **not** a from-scratch design — a substantial, tested, deployed system already
exists. This report grades what's real, flags where documentation has drifted from code, and lays
out a phased roadmap to close the genuine gaps. See the "Scope decision" note at the end for why
this path was chosen over a rebuild.

Every claim below was verified against the current repo state (schema, source files, docs), not
recalled from memory — file counts and code excerpts are cited so they can be spot-checked.

---

## 0. Headline finding: the docs lie about the code (in the safe direction)

`docs/ARCHITECTURE.md`, `docs/ai/architecture.md`, `docs/saas/*.md`, `docs/import-export.md`, and
`docs/integrations/overview.md` are all still labeled **"design only — not implemented"** or
**"[PLANNED]"**. That was true when they were written (during the "deep-foundation-first" phase —
ADR 0004). It is no longer true. Since then, six domains went from empty seam to real, working
modules with controllers, services, and tests:

| Module | Doc says | Code actually has |
|---|---|---|
| `ai` | "skeleton, no logic implemented" | `ai.controller.ts`, `ai.service.ts`, `providers/openrouter.provider.ts`, `tools/tool-definitions.ts` + `tool-executor.service.ts` + `validate-tool-args.ts`, e2e-tested (`test/ai.e2e-spec.ts`) |
| `billing` | "Nothing — the billing module is a skeleton" | `payments.controller.ts`, `payments.service.ts`, backed by real `Payment`/`Refund` Prisma models |
| `workouts` | not mentioned as built | `exercises.*`, `workout-plans.*`, `workout-assignments.*` — 3 controllers/services |
| `nutrition` | not mentioned as built | `food-items.*`, `diet-plans.*`, `diet-assignments.*` — 3 controllers/services |
| `inventory` | not mentioned as built | `products.*`, `stock-movements.*` |
| `crm` | not mentioned as built | `leads.*` (leads + follow-ups) |

`docs/security/overview.md` **is** current (references branch-scoping, assignment-scoping, and AI
tool-executor tests that actually exist). The drift is isolated to the architecture/design docs
that predate the build-out. **First action item, independent of any new feature work: refresh
`docs/ARCHITECTURE.md` and the design-only docs to reflect reality**, or the next person (human or
agent) who reads them will under-estimate the system and risk re-building what already exists —
which is almost exactly the mistake this master prompt's premise ("build from scratch") would have
caused here.

---

## 1. Complete system architecture

Two repositories, one product: `mygymagent-b` (NestJS 11 modular monolith, REST, PostgreSQL via
Prisma 6) and `mygymagent-f` (Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui), deployed
separately (Render + Vercel) against a shared Supabase Postgres instance, on a shared git branch
during initial development (ADR 0005 explains why two repos, not a monorepo — independent deploy
cadence and blast radius, at the cost of manual type-contract sync, which ADR 0005 accepts).

This is a **modular monolith**, correctly so at current scale — 25 domain modules under `src/`,
each owning its controllers/services/DTOs, registered once in `AppModule`. There is no premature
service split; that's the right call per the master prompt's own instruction ("prefer a modular
monolith... unless there is a genuine reason for distributed services") and nothing in the current
domain surface justifies one yet.

## 2. Domain / bounded-context map

| Domain | Status | Module |
|---|---|---|
| Organizations, Branches | **Built** | `organizations/`, `branches/` |
| Auth (register/login/refresh/logout/reset/verify) | **Built** (email/password only) | `auth/` |
| RBAC (permissions, roles, overrides) | **Built** | `rbac/` |
| Users/Staff | **Built** | `users/` |
| Audit | **Built** | `audit/` (+ `common/` interceptor) |
| Members | **Built, shallow** — see §6 | `members/` |
| Membership plans + subscriptions | **Built** | `membership-plans/`, `memberships/` |
| Attendance | **Built** | `attendance/` |
| CRM (leads + follow-ups) | **Built** | `crm/` |
| Billing (payments, refunds) | **Built, narrow** — no invoices, no platform billing | `billing/` |
| Workouts (exercises, plans, assignments) | **Built** | `workouts/` |
| Nutrition (foods, diet plans, assignments) | **Built** | `nutrition/` |
| Inventory (products, stock movements) | **Built** | `inventory/` |
| AI (tool-scoped agent executor) | **Built, no persistence** — see §10 | `ai/` |
| Platform admin (cross-tenant) | **Built** | `platform/` |
| Notifications | **Stub** (`Module` class + README only) | `notifications/` |
| Files/object storage | **Stub** | `files/` |
| Search | **Stub** (11-line module file) | `search/` |
| Analytics | **Stub** | `analytics/` |
| Events (domain event bus) | **Built, thin catalog** — see §11 | `events/` |
| **Assessments** | **Absent** — no module, no schema | — |
| **Goals** | **Absent** — no module, no schema | — |
| **Appointments/Scheduling** | **Absent** — no module, no schema | — |
| **PT-specific (packages/sessions/commissions)** | **Absent** — `workouts` covers programming, not PT-package commerce | — |
| **Communication (WhatsApp/SMS/email delivery)** | **Absent** — only a logging-stub mailer | — |

18 of 22 domains from the master prompt's list have at least a reserved seam; 14 have real code
behind them. The four genuinely missing domains (Assessments, Goals, Appointments, PT-packages)
are new work, not "finish what's stubbed."

## 3. Multi-tenant strategy

**Hierarchy:** Platform → Organization (self-relating via `parentOrganizationId` for
franchise/holding groups) → Branch → User/Staff → Member. Confirmed correct and consistently
applied.

**Enforcement:** service-layer scoping, not database RLS. Every tenant-owned table carries
`organizationId`; every service method takes it from `@CurrentUser()`, itself populated only from
a verified JWT + live DB re-lookup on every request (`JwtStrategy.validate()`), never from a
client-supplied param. Every `findFirst`/`update`/`delete` folds `organizationId` into the same
`where` as the record id, so a cross-tenant id simply doesn't match — 404, not 403, so a caller
can't distinguish "doesn't exist" from "exists but isn't yours" (ADR 0001).

**Branch-level scoping** goes further than most SaaS starters: `PermissionsGuard` resolves *how* a
permission was granted (org-wide vs. branch-scoped `UserRole.branchId`) and exposes it as
`request.branchScope`; Members/Attendance/Payments/Memberships/Leads/Users all fold that into their
`where` clauses, tested end-to-end (`test/branch-scoping.e2e-spec.ts`).

**Assignment-level scoping** (narrower still): `@RequireAnyPermission('members.read',
'members.read_assigned')` lets TRAINER see only members where `assignedTrainerId` matches them,
tested in `test/member-assignment-scoping.e2e-spec.ts`. NUTRITIONIST is deliberately excluded from
this mechanism (documented reason: its assignment relationship is `DietAssignment.assignedByUserId`,
a join this decorator pattern doesn't do) — a real, honest, tracked gap rather than a silent one.

**RLS**: evaluated and explicitly deferred (ADR 0001) — correct call at current scale; revisit only
if a direct-DB consumer (e.g. an analytics warehouse) bypasses the API.

**Verdict:** this is the strongest section of the existing system relative to the spec. §3's
tenant-isolation requirement ("prove Tenant A can never access Tenant B data... across API,
database, search, files, reports and AI") is met for API/database/AI; **not yet provable for
search, files, or reports**, because those modules don't exist yet to test.

## 4. Complete entity inventory

29 Prisma models. Grouped:

- **Tenancy root:** `Organization`, `Branch`
- **Identity/auth/RBAC:** `User`, `StaffProfile`, `Permission`, `Role`, `RolePermission`,
  `UserRole`, `UserPermissionOverride`, `RefreshToken`, `PasswordResetToken`,
  `EmailVerificationToken`
- **Audit:** `AuditLog`
- **Members/CRM:** `Member`, `Lead`, `LeadFollowUp`
- **Membership:** `MembershipPlan`, `Membership`
- **Attendance:** `Attendance`
- **Billing:** `Payment`, `Refund`
- **Workouts:** `Exercise`, `WorkoutPlan`, `WorkoutAssignment`
- **Nutrition:** `FoodItem`, `DietPlan`, `DietAssignment`
- **Inventory:** `Product`, `StockMovement`

125 lines of permission catalog, 15 system roles, 8 migrations, 13 e2e test files.

Full field-level detail already lives in `docs/database/erd.md` and `docs/database/data-ownership.md`
(owner/tenant-scope/branch-scope/history/audit/AI-access/API-exposure answered per table before it
was built — a genuinely good practice, keep it going for every new table).

## 5. ERD

See `docs/database/erd.md` for the current diagram/description. Not reproduced here to avoid a
second source of truth drifting from the first — **the gap this report exists to prevent**. New
entities from the phased roadmap (§21) must be added there as they're designed, before code, per
the project's own established practice (ADR 0004).

## 6. Member 360 architecture — the deepest gap

This is the master prompt's most emphasized requirement (§6, §11) and the current system's biggest
shortfall relative to spec. Today `Member` is **one flat table**: identity, one inline address,
one inline emergency contact, `assignedTrainerId`, `status`, `notes`, `profilePhotoUrl`, optional
portal `userId`. It correctly relates out to `Membership`, `Attendance`, `Payment`,
`WorkoutAssignment`, `DietAssignment`, `Lead` — so cross-domain history exists and is real — but
none of the following exist as first-class, historical entities:

- Multiple addresses / multiple emergency contacts (currently one of each, inline, overwritable)
- Tags
- Notes as a **collection** with authorship/timestamps (currently one `notes` text field — a second
  note overwrites the first; no history)
- Documents, consents/waivers
- Screenings (PAR-Q), assessments, body measurements, body composition, fitness tests
- Progress photos
- Goals + goal milestones
- Status history (a status change today is a field mutation with no trail — contradicts §6's
  explicit "preserve historical data... changing a trainer/goal/... must NOT destroy history")
- Branch-transfer history (`primaryBranchId` is a live field with no history table)
- A unified activity/timeline feed (would need to aggregate across all the above plus
  Membership/Attendance/Payment/Workout/Diet events)

**This is genuinely new modeling work**, not a matter of exposing what already exists. It's also
the highest-leverage gap to close first: almost every other missing domain (Assessments, Goals,
Appointments) is *specifically* a Member 360 sub-entity, so designing Member 360 properly is a
prerequisite for those, not parallel work.

## 7. Membership / CRM / Attendance architecture

All three **built** and reasonably deep:

- **Membership**: plan→subscription model with price snapshotting at purchase (protects historical
  revenue reporting from later price changes — correct pattern), freeze/cancel/resume as status
  transitions rather than deletes, `previousMembershipId` reserved for upgrade/transfer lineage
  (not yet wired to an actual upgrade flow — worth confirming that's still true before building
  Goals/Assessments history, since it's the same "preserve lineage" pattern needed there).
- **CRM**: `Lead` + `LeadFollowUp` — pipeline/source/follow-up tracking exists; no explicit
  conversion-funnel/stage-analytics layer yet (that's `analytics/`'s job, still a stub).
- **Attendance**: check-in/out, branch-scoped, indexed on `(organizationId, branchId, checkInAt)`
  for the query patterns that matter at scale. No QR/barcode/kiosk *client* exists yet — the API
  shape supports any check-in source, but no dedicated kiosk UI or QR-generation endpoint was found.

## 8. PT / Workout / Nutrition / Assessment architecture

**Workout Engine**: `Exercise` / `WorkoutPlan` / `WorkoutAssignment` — programming exists
(assign a plan to a member, presumably with exercises/sets/reps inside `WorkoutPlan`'s structure —
confirm against `docs/database/erd.md` for exact depth of sets/reps/RPE/tempo/superset modeling,
not re-derived here). No PR (personal-record) tracking or workout-session-completion history
table was found as a distinct entity — worth confirming whether "workout history" beyond the
assignment record exists, or whether that's still open work.

**Nutrition**: `FoodItem` / `DietPlan` / `DietAssignment` — same shape as workouts. No adherence
tracking (did the member follow the plan) was found as a distinct entity.

**PT-as-commerce** (packages, session balances, trainer commissions/payouts) is **entirely
absent** — `workouts` covers the training-plan side, not the "member bought 10 PT sessions, has 6
left, trainer gets a commission per session" side. This is a distinct domain from Workouts in the
master prompt's own taxonomy (§5) and should be modeled that way here too, likely sitting partly in
`billing` (packages are a purchasable SKU) and partly in a new PT-scheduling concept.

**Assessments** (PAR-Q, measurements, body composition, fitness tests, progress photos): **absent**,
per §6.

## 9. Finance / Inventory architecture

**Finance**: `Payment` + `Refund` exist and correctly represent *gym operational billing* (member
pays gym) per `docs/saas/billing-separation.md`'s design — but that doc's own "what exists today:
nothing" line is stale (§0). What's missing against the design doc's own spec: no `Invoice` model,
no discounts/taxes as first-class concepts, no trainer commission/payout tables, and critically —
**no platform SaaS billing at all** (`PlatformSubscription`, `PlatformInvoice` from
`docs/saas/billing-separation.md` are still unimplemented design). The separation the doc argues
for (never let the two financial concerns share a table) is easy to honor going forward *because*
it hasn't been violated yet — no `Payment` row represents platform revenue.

**Inventory**: `Product` + `StockMovement` — real stock-in/stock-out tracking. No supplier/purchase-
order/batch/expiry modeling was found (the master prompt's §5 inventory scope goes further:
suppliers, batches, expiry, transfers, low-stock alerts). `StockMovement` likely already captures
the transaction log needed as a foundation; the missing pieces are supplier/batch/expiry as
reference data and an alert mechanism (which needs the event bus + notifications, both partially
built).

## 10. AI architecture

**Real strengths**, better than the median SaaS AI integration:

- Tool-based, not chat-with-raw-DB-access: `tool-definitions.ts` + `tool-executor.service.ts` +
  `validate-tool-args.ts` (`class-validator`-backed argument validation per tool, matching the
  pattern used everywhere else in this codebase).
- e2e tested directly against the tool executor (no live model dependency) —
  `test/ai.e2e-spec.ts` confirms `read_member` never returns cross-org data or raw PII fields, and
  `create_workout_draft`/`create_diet_draft` reject cross-org exercise/food references.
- Every tool calls the same tenant-scoped domain service the REST API uses (per
  `docs/ai/architecture.md`'s own rule) — confirmed, not just documented.
- Single provider adapter today (`openrouter.provider.ts`) — matches the documented "provider
  adapter, never a vendor SDK called directly" pattern, ready to add Anthropic/OpenAI/Google
  adapters behind the same interface without touching callers.

**Real gaps** against the AI architecture doc's own stated requirements:

- **No persistence at all.** No `AiConversation`, `AiMessage`, or `AiUsageLog` model exists in the
  schema. That means: no conversation memory (§10 of the master prompt's memory-separation
  requirement can't exist without a table to hold it), and — more urgently — **no per-org AI
  cost/usage tracking**, which `docs/ai/architecture.md`'s own §58 calls a hard requirement ("every
  AI call logs organizationId, token count, and estimated cost") and which `docs/saas/plans-and-
  limits.md` explicitly depends on for enforcing AI usage as a plan-limited resource. Right now
  nothing stops a runaway AI feature from being an unbounded cost with zero visibility.
- No Model Router (single provider today — fine at current scale, but the "cheap model for
  classification, strong model for generation" cost-tiering from the design doc isn't implemented).
- No structured-output-validation-with-retry loop confirmed (needs a direct read of
  `ai.service.ts` to verify against the design's "validate → retry with error fed back → bounded
  retries" flow — flagged as worth confirming, not asserted as missing, since I didn't trace that
  file's full logic in this pass).
- No memory/RAG layer — no semantic retrieval, no member-memory vs. org-memory vs.
  approved-AI-memory separation (§10 of the master prompt). Not surprising given there's no
  persistence layer yet at all; this is a natural next layer once conversations are stored.

**Verdict**: the *safety* architecture (tool allowlist, tenant scoping, no raw SQL) is genuinely
solid and matches the master prompt's hard rules. The *product* architecture (memory, cost
tracking, multi-model routing) is the part still missing, and cost tracking specifically is a
production risk, not just a feature gap — it should be prioritized ahead of adding new agents.

## 11. Event / job architecture

**Real but thin.** `@nestjs/event-emitter` (in-process `EventEmitter2`, not a durable queue) is
wired and actually used — `member.created`, `membership.started`, `membership.cancelled`,
`attendance.recorded` are emitted from their respective services today, confirmed in code, not just
documented. This is a real domain event bus, correctly decoupling emitters from (future)
subscribers, and is fine for **in-process, best-effort** fanout (e.g. a future notification that's
okay to lose on a crash mid-request).

**The gap the docs already flag correctly**: no Redis/BullMQ or equivalent durable queue exists
(`package.json` confirmed — no `bullmq`, `ioredis`, or similar dependency). `docs/import-export.md`
is explicit that this is "a genuine infrastructure gap, not just missing business logic" and must
land *before* import/export, notifications-at-scale, or any background job that must survive a
process restart or scale past one instance. `PaymentReceived`, `WorkoutAssigned`, `LeadConverted`,
`InventoryLow` — the rest of the master prompt's event catalog (§12) — are all straightforward to
add to `events/domain-events.ts` once producers exist; the actual blocker is queue infrastructure
for anything that needs retry/durability, not the event definitions themselves.

## 12. API architecture

Consistent, well-conventioned REST API (`docs/api/conventions.md`): global guard chain
(`ThrottlerGuard` → `JwtAuthGuard` → `PermissionsGuard`), uniform success envelope (`{ data, meta:
{ requestId } }`) and error envelope (`{ error: { code, message, details?, requestId } }`),
`AllExceptionsFilter` scrubbing raw Prisma errors before they reach a client, `class-validator` DTOs
with `whitelist: true, forbidNonWhitelisted: true` (unexpected fields are a hard 400 — this is what
makes "can't inject `organizationId`" a structural guarantee rather than developer discipline).
Request-id correlation end-to-end (logs, audit rows, error responses). No GraphQL, no API
versioning scheme yet (fine — no external API consumers yet to force the question).

## 13. Frontend architecture

Next.js App Router, ~20 routed pages under `(app)/`, permission-aware `nav-config.ts` driven by
`GET /auth/me`'s permissions array (client-side hiding is UX only — confirmed the backend is the
real boundary per §6/§12). Recent work (this session, prior to this report) fixed a systemic design-
token bug and a cross-site cookie bug that was silently logging every user out on refresh in
production — both real production correctness issues, now fixed, which is a good sign the team
notices and fixes real bugs rather than only shipping features. Shared component layer
(`data-table`, `empty-state`, `error-state`, `stat-card`) exists and is reused, not copy-pasted per
page — correct instinct at this scale, watch for it staying that way as domain count grows.

No virtualized-table implementation confirmed for large lists yet (§15 "never load massive datasets
into the browser") — worth checking `data-table.tsx` against real member-list-at-10k-rows behavior
before that becomes a real customer's problem, not before.

## 14. Security architecture

Covered in depth already in `docs/security/overview.md`, which is accurate and current (§0). Not
re-derived here in full; headline gaps the doc itself already discloses honestly:

- Malicious upload / unauthorized file access: N/A, `files` module unbuilt.
- Prompt injection: structurally mitigated (tool allowlist + argument validation) but no test drives
  a crafted prompt through a live model end-to-end — needs a real API key to test, not yet run.
- No MFA, no OAuth, no passkeys/WebAuthn (User.passwordHash is nullable, anticipating this, per
  ADR 0002 — schema is ready, auth flows aren't built).
- No CSRF-specific test — argued as low-risk given no cookie-authenticated state-changing GET
  exists, worth re-checking once/if that changes.

## 15. Repository structure

Two repos (`mygymagent-f`, `mygymagent-b`), not a monorepo — deliberate (ADR 0005), trading a small
amount of manual type-sync discipline for independent deploy blast radius. Backend organized by
domain (`src/<domain>/`), not by technical layer — correct per master prompt §21's spirit even
though the literal `apps/`+`packages/` monorepo layout wasn't used; the reasoning in ADR 0005 for
why is sound and should stand unless/until a real driver (e.g. a third client needing to share
generated types) forces reconsideration.

## 16. Testing strategy

Genuinely good foundations, honestly scoped (`docs/testing/strategy.md` — this one specific doc,
unlike its siblings, appears to still track close to actual test file counts; worth a quick refresh
pass alongside the others in §0's action item). 13 e2e spec files exist today covering: health,
auth (register/login/refresh-rotation/logout/lockout), the tenant-isolation suite (**the most
important test in the codebase**, per the doc's own accurate self-assessment), branch-scoping,
member-assignment-scoping, rate-limiting, platform-admin access, and AI tool-executor authorization.

**Confirmed honest gaps** (stated as such by the docs, verified still true): no load/performance
testing at the target scale (millions of rows), no frontend/backend contract tests, no coverage
threshold enforced in CI, no live-model AI evaluation harness (structured-output robustness,
prompt-injection resistance against a real model rather than the tool executor directly).

## 17. Deployment strategy

Render (backend) + Vercel (frontend) + Supabase (Postgres), `.github/workflows/ci.yml` exists for
CI. `npm start` runs `prisma migrate deploy && node dist/src/main` (fixed this session, prior to
this report, after production drifted from migrations) — this is a reasonable pattern at current
scale (single backend instance) but has a known sharp edge worth documenting explicitly if it
isn't already: **concurrent deploys of multiple instances would each try to run migrations
simultaneously.** Fine today; revisit before horizontal-scaling the API past one instance.

## 18. Observability

`GET /health` (DB connectivity + latency), request-id correlation across logs/errors/audit rows,
structured `Logger` output. No metrics endpoint, no distributed tracing, no error-tracking SaaS
(Sentry or equivalent) wired up — a 500 today is only visible via server logs, not aggregated or
alerted on. This is the most operationally risky gap for a system already serving real production
traffic: **error tracking should be prioritized ahead of new feature domains**, because right now a
production regression is only found when a user reports it (as already happened this session with
the "Something went wrong loading this data" report).

## 19. Performance strategy

Composite indexes exist where the built domains' actual query patterns need them (e.g.
`(organizationId, branchId, checkInAt)` on `Attendance`) — "designed for scale," per the testing
doc's own honest caveat, not "verified against scale" (no load test exists yet). No caching layer,
no read replica strategy, no aggregation/materialized-view strategy for analytics (moot today since
`analytics/` is a stub) — all reasonable to defer until there's real data volume to tune against,
per the master prompt's own "avoid over-engineering" instruction (§24).

## 20. Risks and mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Docs claim domains are unbuilt when they're live in production | High (misleads future work, already nearly caused a from-scratch rebuild this session) | Refresh `docs/ARCHITECTURE.md` + design-only docs now, before Phase-by-phase work resumes |
| No AI cost/usage tracking | High (unbounded cost exposure on a real API key) | Add `AiUsageLog` + per-call logging before adding new agents/features to `ai/` |
| No error tracking / alerting | High (production bugs found only via user reports) | Wire Sentry (or equivalent) before further feature work |
| Member 360 is a flat table, no history on status/branch/trainer changes | Medium-high (violates the product's own explicit "preserve history" requirement; also blocks Goals/Assessments which need the same pattern) | Design Member 360 sub-entities (§6) before building Goals/Assessments/Appointments on top of the current flat model |
| No durable job queue | Medium (blocks import/export, at-scale notifications, retryable background AI work) | Introduce BullMQ+Redis (or equivalent) as its own infra phase before building on top of it, per `docs/import-export.md`'s own correct call |
| No platform SaaS billing | Medium (the business can't yet charge organizations) | Build `PlatformSubscription`/`PlatformInvoice` once a payment processor integration is prioritized |
| No MFA/OAuth/passkeys | Low-medium (email/password + account lockout is a reasonable baseline; not a blocker for most gyms) | Build when a customer/segment actually needs it — schema is already ready (nullable `passwordHash`) |

## 21. Phase-by-phase roadmap (gap-closure, not rebuild)

Numbering continues from where the existing system already stands — **Phases 0–8 of the master
prompt's own phase list are effectively done** (architecture/ADRs exist; repo/CI/Docker exist;
database + multi-tenancy exist; auth + RBAC exist; org/branch/staff exist; Members/CRM/
Memberships/Attendance exist; a first cut of PT-adjacent Workouts/Nutrition exists). What's left:

**Phase A — Stop the bleeding (do first, before any new domain)**
1. Refresh `docs/ARCHITECTURE.md` and every doc still marked "design only" to reflect reality (§0).
2. Wire error tracking (Sentry or equivalent) — currently zero visibility into production 5xxs.
3. Add `AiUsageLog` (organizationId, provider, model, tokens, cost, latency, feature, status) and
   log every AI call — closes the unbounded-cost risk in §10/§20 before building more AI features.

**Phase B — Member 360 (foundational, everything else in this list builds on it)**
4. Design (doc first, per the project's own established practice) then build: multiple addresses,
   multiple emergency contacts, a real notes collection (not one overwritable field), documents,
   consents, status history, branch-transfer history — the "preserve history" entities from §6.
5. Build Assessments (PAR-Q/screening, measurements, body composition, fitness tests, progress
   photos) as first-class historical entities tied to Member.
6. Build Goals + goal milestones, tied to Member and (optionally) to a workout/nutrition plan.

**Phase C — Appointments + PT-as-commerce**
7. Appointments/scheduling (PT, assessment, nutrition, consultation, trial, follow-up) — needs a
   calendar/availability model not present anywhere today.
8. PT packages (session balances, purchase, consumption) and trainer commissions/payouts — sits
   partly in `billing`, partly in a new PT-scheduling concept; do not conflate with `WorkoutPlan`.

**Phase D — Infrastructure that unblocks everything downstream**
9. Durable job queue (BullMQ + Redis or equivalent) — prerequisite for Phase E and F below.
10. Object storage (`files/`) — prerequisite for Assessments' progress photos (Phase B) and
    documents, and for Communication attachments (Phase F).

**Phase E — Finance completion**
11. Invoices, discounts, taxes as first-class entities alongside the existing `Payment`/`Refund`.
12. Platform SaaS billing (`PlatformSubscription`, `PlatformInvoice`) — separate model family, per
    `docs/saas/billing-separation.md`'s already-correct design; needs Phase D's queue for webhook
    processing from whichever payment processor is chosen.
13. Plans/limits + feature flags enforcement (`docs/saas/plans-and-limits.md`,
    `docs/saas/feature-flags.md`) — server-side enforced, not UI-only, per those docs' own rule.

**Phase F — Communication + Notifications**
14. Build out `notifications/` for real (subscribing to the existing event bus — `member.created`
    etc. already fire, nothing consumes them yet) — needs Phase D's queue for reliable delivery.
15. WhatsApp/email/SMS adapters behind the interfaces `docs/integrations/overview.md` already
    specifies — implement the adapters, the seam is already designed correctly.

**Phase G — Search, Analytics, Import/Export**
16. `search/` — start with Postgres full-text search per the existing (correct) plan; don't
    introduce dedicated search infra preemptively.
17. `analytics/` — KPI aggregation, event-bus-triggered incremental aggregation per the existing
    (correct) design in `docs/ARCHITECTURE.md` §14.
18. Import/export per `docs/import-export.md`'s already-designed validate-before-commit flow —
    needs Phase D's queue.

**Phase H — Auth expansion + hardening**
19. MFA, OAuth, passkeys/WebAuthn — build when a real customer segment needs it; schema is ready.
20. Load/performance testing at target scale; frontend/backend contract tests; live-model AI
    evaluation harness (structured-output robustness, prompt-injection resistance).

Each phase item should still go through the project's own quality gate (build → typecheck → lint →
test → tenant-isolation test → security review → document → verify) before being called done — that
discipline is real in this codebase already (13 e2e suites, ADRs written before code, data-ownership
matrix answered per table before implementation) and should not lapse as new domains are added.

---

## Scope decision (for the record)

The master prompt that triggered this report assumed a greenfield build. A repository inspection
found a live, deployed, multi-tenant system already covering most of the requested surface, with
real tenant-isolation testing and a documented ADR trail. Discarding that in favor of a from-scratch
rebuild was raised explicitly with the user and declined in favor of gap-analysis + extend — this
report is that gap analysis. No code was changed to produce it; the next step is Phase A above,
pending direction on priority order.
