# MyGymAgent — Technical Blueprint

This is the architecture blueprint for the AI-driven, multi-tenant Gym Management + Personal
Training platform. Two repositories, `mygymagent-b` (this repo, the NestJS/PostgreSQL API) and
`mygymagent-f` (Next.js frontend), sharing one branch during initial development.

**Build strategy: deep foundation first, then breadth.** The initial phase built multi-tenancy,
auth/RBAC, audit logging, and the core gym domain (organizations, branches, staff, members,
membership plans/subscriptions, attendance) to a real production standard, end-to-end (DB → API →
tests), with every other domain's module seam reserved (`src/<domain>/`, empty `@Module({})` +
README) and permission keys pre-seeded. Since then, six more domains have been built out for real:
**AI (v1 tool-calling agent), billing (payments/refunds), workouts, nutrition, inventory, and CRM
(leads)**. Notifications, files, search, and analytics are still reserved seams, not built.
Sections below mark each domain **[BUILT]** or **[PLANNED]** accordingly — see
`docs/architecture/discovery-report.md` for a fuller, dated audit of built-vs-planned across every
domain, including sub-entity-level gaps (e.g. Member 360) this summary doesn't go into.

---

## 1. Product architecture

Single API (`mygymagent-b`) serving a Next.js web app (`mygymagent-f`), with room for a future
mobile/member-portal client against the same REST API. The API is the single source of truth and
the only place authorization is enforced — the frontend renders based on permissions but never
substitutes for a server-side check.

## 2. Domain architecture

Modules are organized by business domain, not by technical layer (`src/members/`, not
`src/controllers/` + `src/services/`). Each domain module owns its controller(s), service(s), DTOs,
and is registered once in `AppModule`. Cross-domain effects go through the domain event bus
(§10), not direct service imports, to keep modules loosely coupled as the system grows.

## 3. Multi-tenant architecture **[BUILT]**

Hierarchy: **Platform → Organization → Branch → Users/Staff → Members**. `Organization` also
self-relates (`parentOrganizationId`) so a franchise/holding company can group multiple legal
entities without merging their data.

**Enforcement model:** every tenant-owned table carries `organizationId` (and usually `branchId`).
There is no ORM-level automatic tenant filter (Prisma has no first-class row-security hook for our
setup) — instead, **every domain service method takes `organizationId` from `@CurrentUser()`**,
which is populated exclusively from the verified JWT + a live DB lookup
(`src/auth/strategies/jwt.strategy.ts`), **never from a client-supplied body/query param**. Every
`findFirst`/`update`/`delete` includes `organizationId` in the same `where` clause as the record
id, so a cross-tenant id simply doesn't match — no separate ownership check, no distinguishable
404-vs-403 timing/response leak. See `src/members/members.service.ts` for the canonical pattern.

This is regression-tested directly: `test/tenant-isolation.e2e-spec.ts` spins up two real
organizations and asserts Tenant A can never read, list, update, or delete Tenant B's branches,
members, membership plans, or memberships — including via id-guessing and via an injected
`organizationId` in a request body (rejected by strict DTO validation, §17).

Row Level Security (Postgres RLS) was evaluated as defense-in-depth and deliberately deferred: the
service-layer scoping above is enforced and tested; RLS would duplicate that logic at the DB layer
and adds real operational complexity (every connection needs a session-scoped tenant claim). Worth
revisiting once there are direct-DB consumers (e.g. an analytics warehouse) that don't go through
the API.

## 4. Database architecture **[BUILT for the domains listed below]**

PostgreSQL via Prisma (`prisma-client-js` generator — see the note in §19 on why not the newer
driver-adapter generator). `prisma/schema.prisma` is organized in sections:

- **Tenancy root**: `Organization`, `Branch`.
- **Identity/auth/RBAC**: `User`, `StaffProfile`, `Permission`, `Role`, `RolePermission`,
  `UserRole`, `UserPermissionOverride`, `RefreshToken`, `PasswordResetToken`,
  `EmailVerificationToken`.
- **Audit**: `AuditLog` (immutable — application code only ever inserts, never updates/deletes).
- **Core gym domain**: `Member`, `MembershipPlan`, `Membership`, `Attendance`.
- **Billing**: `Payment`, `Refund` (gym-side; platform SaaS billing is still unmodeled — see
  `docs/saas/billing-separation.md`).
- **Workouts**: `Exercise`, `WorkoutPlan`, `WorkoutAssignment`.
- **Nutrition**: `FoodItem`, `DietPlan`, `DietAssignment`.
- **CRM**: `Lead`, `LeadFollowUp`.
- **Inventory**: `Product`, `StockMovement`.
- **AI**: `AiUsageLog` (per-request token/cost/latency tracking; no conversation-persistence table
  yet — see §9).

`Member` today is intentionally still the "core gym domain" version from the deep-foundation phase
— one flat table, no sub-entities for assessments/goals/documents/consents/history. See
`docs/architecture/discovery-report.md` §6 for what a full Member 360 model needs; it hasn't been
built yet and is the single largest schema gap in the system.

Conventions: UUID primary keys; `createdAt`/`updatedAt` on every table; soft delete
(`deletedAt`) where a record has downstream references that must survive deletion (Organization,
Branch, User, Member); **financial/history immutability** — `Membership` snapshots `price` at
purchase time (so a later plan price change never rewrites history) and freeze/upgrade/cancel
operations mutate status fields rather than deleting rows; membership chaining
(`previousMembershipId`) is reserved for future upgrade/transfer flows that need to preserve the
full lineage instead of overwriting a row in place. Indexes are on every foreign key plus the
query patterns the built modules actually use (e.g. `(organizationId, branchId, checkInAt)` on
`Attendance`).

**[PLANNED]** Tables for billing/payments, workouts, nutrition, inventory, CRM/leads,
notifications, AI conversations/usage, files/media will be added by their respective modules,
following the same `organizationId`/`branchId` scoping and immutability conventions.

## 5. Authentication architecture **[BUILT: email/password. PLANNED: OAuth, passkeys, MFA]**

JWT access tokens (15 min default, `src/auth/tokens.service.ts`) signed with a dedicated secret;
**opaque, high-entropy refresh tokens** (not JWTs) so they can be listed as devices and revoked
individually — only their SHA-256 hash is persisted (`RefreshToken` table). Refresh tokens live in
an `httpOnly`, `secure` (in production), `sameSite=lax` cookie scoped to `/auth`; access tokens are
returned in the JSON body for the frontend to hold in memory. Refresh rotates on every use (old
token revoked, new one issued) — see `AuthService.refresh`.

`JwtStrategy.validate()` re-reads the user from the database on every request rather than trusting
JWT claims for anything but the user id, so a suspension or role change takes effect immediately
instead of waiting for a 15-minute token to expire (the acknowledged cost: one indexed lookup per
request — a candidate for a short-TTL cache once load requires it).

Account lockout: 5 failed attempts locks the account for 15 minutes
(`MAX_FAILED_LOGIN_ATTEMPTS`/`LOCKOUT_DURATION_MS` in `auth.service.ts`), independent of the
HTTP-level rate limiting on `/auth/login` and `/auth/register` (`@Throttle`, `ThrottlerModule`).
Password reset and email verification both use single-use, expiring, hashed opaque tokens
(`PasswordResetToken`, `EmailVerificationToken`); a password reset revokes every refresh token for
that user (force re-login everywhere). Login failure messages are identical whether the account
exists or not, to avoid user enumeration.

**[PLANNED]** Google OAuth, WebAuthn/passkeys, and MFA are architected for (the `User` table has
room — `passwordHash` is already nullable for OAuth/passkey-only accounts) but not implemented in
this phase. No biometric data is ever intended to be stored directly — passkeys/WebAuthn delegate
that to the platform authenticator by design.

## 6. Authorization architecture **[BUILT]**

RBAC with `resource.action` permission keys (`src/rbac/permissions.catalog.ts` — e.g.
`members.read`, `payments.refund`, `ai.generate`), enforced by a global `PermissionsGuard` reading
`@RequirePermissions(...)` metadata. **A route with no decorator is merely "authenticated"; a route
that declares permissions is denied unless every one is satisfied** — deny-by-default throughout
(`JwtAuthGuard` is also global; routes opt out individually with `@Public()`).

Roles (`src/rbac/roles.catalog.ts`) are system-seeded (Platform Owner/Admin, Organization
Owner/Admin, Branch Manager, Head Trainer, Trainer, Nutritionist, Receptionist, Sales Executive,
Accountant, Inventory Manager, Staff, Member) and available to every organization
(`Role.organizationId = null`); organizations can additionally define custom roles
(`Role.organizationId` set) with their own permission grants. Role assignment
(`UserRole`) can be organization-wide or scoped to a single branch (`branchId` set), so "Branch
Manager at Branch X" and "Organization Admin" are both first-class. Per-user
`UserPermissionOverride` rows layer ALLOW/DENY exceptions on top of role-derived permissions, with
**DENY always winning** (`PermissionsService.hasPermission`, unit-tested in
`permissions.service.spec.ts`).

The permission catalog already includes keys for domains not yet built (`payments.*`,
`workouts.*`, `inventory.*`, `ai.*`, ...) so role definitions and the frontend's permission-aware
navigation can be written against a stable key set now.

## 7. Backend architecture **[BUILT]**

NestJS, modular by domain (see §2). Global cross-cutting concerns are wired once in `AppModule`
via `APP_GUARD`/`APP_INTERCEPTOR` tokens: `ThrottlerGuard` → `JwtAuthGuard` → `PermissionsGuard` on
the guard side; `ResponseInterceptor` (wraps every success response as `{ data, meta: { requestId
} }`) and `AuditInterceptor` on the interceptor side. `AllExceptionsFilter` standardizes every
error as `{ error: { code, message, details?, requestId } }` and makes sure raw Prisma errors
(`P2002`, `P2025`) never leak table/column names to the client. `RequestIdMiddleware` stamps a
request id (from `x-request-id` or generated) used to correlate logs, audit rows, and error
responses. Every DTO uses `class-validator`; the global `ValidationPipe` runs with
`whitelist: true, forbidNonWhitelisted: true` — an unexpected body field is a hard 400, not a
silently-ignored one (see the tenant-isolation test for why that matters).

## 8. Frontend architecture **[BUILT — `mygymagent-f`]**

Next.js App Router, TypeScript, Tailwind, shadcn/ui, ~20 routed pages under `(app)/` covering every
built backend domain plus a permission-aware dashboard. A typed API client wraps the
`{ data, meta }` / `{ error }` envelope this API returns, with Zod schemas mirroring the backend
DTOs. Server components by default; client components only where interactivity requires them.
Navigation is permission-aware, driven by `GET /auth/me`'s `permissions` array — client-side hiding
is UX only, never the authorization boundary (that's always server-side, per §6). Deployed to
Vercel; see `docs/architecture/discovery-report.md` §13 for a couple of open items (no virtualized
large-list rendering confirmed yet).

## 9. AI architecture **[BUILT: v1 tool-calling chat. PLANNED: the full pipeline below]**

Target shape: **AI Gateway → Model Router → Provider Adapters → Specialized Agents → Domain Tools →
Structured Output Validation → Persistence/Audit**. v1 (`POST /ai/chat`, `src/ai/`) is a scoped-down
slice of this: one endpoint, one provider (OpenRouter, behind an adapter — swapping/adding
providers is a new class, not a rewrite), one configured model (no routing yet). What v1 already
gets right, matching the target design's hard rules: the AI layer never queries the database
directly — every tool (`read_member`, `create_workout_draft`, ...) calls the exact same
`organizationId`-scoped domain service the REST API uses, so an AI agent can never do anything the
requesting user couldn't do themselves and can never reach across tenants (tool arguments are
validated via DTOs before touching a service; `organizationId` comes only from the caller's JWT,
never trusted from model output). `create_workout_draft`/`create_diet_draft` write **inert,
unassigned drafts** — a human has to explicitly assign a plan before it affects a member, which is
how v1 satisfies "consequential output needs approval" without a formal approval-queue table yet
(the `ai.approve` permission is reserved for when a tool needs one). Every AI request logs an
`AiUsageLog` row — organization, tokens, cost when known, latency, status — on success and failure
alike. **Not built**: conversation persistence (client resends history each call), model routing,
budget enforcement against the usage log, an approval queue, prompt-injection test coverage against
a live model. See `src/ai/README.md` for the full accounting and `docs/ai/architecture.md` for the
target design these gaps are measured against.

## 10. Event architecture **[BUILT: bus + 4 events. PLANNED: full catalog]**

`@nestjs/event-emitter` (`EventEmitterModule.forRoot()` in `AppModule`) provides a real, in-process
domain event bus — not a stub. `src/events/domain-events.ts` is the event catalog; today it defines
and emits `member.created`, `membership.started`, `membership.cancelled`, and
`attendance.recorded` (see the `EventEmitter2.emit(...)` calls in `MembersService`,
`MembershipsService`, `AttendanceService`). This lets future modules (Notifications, the AI
Retention Agent, analytics aggregation) subscribe without the emitting module knowing they exist.
**[PLANNED]** The rest of the catalog described in the product vision (`PaymentReceived`,
`WorkoutAssigned`, `LeadConverted`, `InventoryLow`, ...) will be added by the module that produces
each event, following the same pattern.

## 11. Notification architecture **[PLANNED — seam reserved]**

`src/notifications/` is an empty module today. `src/common/mailer/mailer.service.ts` is the
interim stand-in for its email channel: it logs instead of sending, which is what makes the auth
email flows (verify email, password reset) fully testable right now without a real provider
wired up. When built, `NotificationsModule` will subscribe to the domain event bus (§10) and fan
out across in-app/email/SMS/WhatsApp/push channels; `MailerService`'s callers won't need to change.

## 12. File/storage architecture **[PLANNED — seam reserved]**

`src/files/` is reserved for an object-storage abstraction (S3-compatible — R2 or equivalent) for
profile photos, progress photos, documents, and exercise media. Large binary data is never intended
to go through PostgreSQL directly; `Member.profilePhotoUrl` and similar fields already anticipate
storing a URL/key rather than bytes.

## 13. Search architecture **[PLANNED — seam reserved]**

`src/search/` is reserved. Plan: start on PostgreSQL full-text search (sufficient for members,
leads, exercises, products at the scale a single gym/franchise operates at); introduce dedicated
search infrastructure only if that stops being sufficient — not preemptively.

## 14. Analytics architecture **[PLANNED — seam reserved]**

`src/analytics/` is reserved for KPI aggregation (MRR, ARPU, churn, attendance, trainer
performance). These are meant to be computed via scheduled aggregation jobs against the operational
tables (or a read replica), not calculated ad hoc on every dashboard request — the domain event bus
(§10) is the natural trigger point for incremental aggregation once this module exists.

## 15. Billing architecture **[BUILT: payments/refunds. PLANNED: invoices, taxes, payouts, platform billing]**

`src/billing/` (`payments.controller.ts`/`payments.service.ts`) covers gym-side `Payment`/`Refund` —
a member paying the gym, org/branch-scoped, following the same immutable-history pattern already
established for `Membership` (§4): a refund is a new linked row, never a mutation of the original
payment. Not yet built: invoices, discounts/taxes as first-class concepts, trainer
payouts/commissions, and — distinct from all of the above — **platform SaaS billing** (the gym
paying *us*), which `docs/saas/billing-separation.md` deliberately models as a separate table
family (`PlatformSubscription`/`PlatformInvoice`) so gym revenue and platform revenue can never
collide in a query. Still fully design-only.

## 16. Audit architecture **[BUILT]**

`AuditLog` is written-only (create, never update/delete) by `AuditService`. Two ways entries get
produced: automatically, via `@Audited({ resource, action })` on any mutating controller method
(captured by the global `AuditInterceptor` — actor, org/branch, the route's `id` param, a
JSON-sanitized response body as `afterState`, IP/user-agent/request-id); or explicitly, by
injecting `AuditService` directly where a hand-written before/after state matters (e.g. role
assignment in `UsersService.assignRole`/`revokeRole`). Every mutating endpoint on the built domain
modules (branches, users, members, membership plans, memberships, attendance) already carries
`@Audited`.

## 17. Security architecture **[BUILT for what's implemented; ongoing]**

- **SQL injection**: Prisma's parameterized queries throughout; no raw SQL in the built modules.
- **Broken access control / IDOR / tenant escape**: §3 and §6 — every query scoped by
  `organizationId` from the verified JWT, every mutating route permission-gated, regression-tested
  in `test/tenant-isolation.e2e-spec.ts`.
- **Mass assignment**: DTOs are explicit allow-lists; `ValidationPipe({ whitelist: true,
  forbidNonWhitelisted: true })` turns an unexpected field into a 400, not a silent write.
- **Rate abuse / brute force**: `ThrottlerModule` globally (120 req/min default) plus tighter
  per-route limits on `/auth/login`, `/auth/register`, `/auth/forgot-password`; independent account
  lockout after repeated failed logins (§5).
- **Token theft**: refresh tokens are opaque, hashed at rest, rotated on every use, and revocable
  individually or all-at-once (`logout-all`); access tokens are short-lived.
- **Secrets/headers**: `helmet()` for standard security headers, `compression()`, CORS restricted
  to a configured origin list with credentials.
- **Error/detail leakage**: `AllExceptionsFilter` normalizes Prisma/driver errors so internal
  details (table/column names, stack traces) never reach the client; 5xx responses are logged
  server-side with the request id for correlation.
- **[PLANNED]** CSRF (not yet relevant — no cookie-authenticated state-changing GET exists, and the
  refresh cookie's `sameSite=lax` plus its use only via an explicit POST already mitigates the
  classic case; revisit if a cookie-based flow expands), SSRF (relevant once the AI/Files modules
  make outbound requests), file-upload validation (once Files module exists), prompt injection
  defense (§9 — designed for, enforced once AI module exists).

## 18. Testing architecture **[BUILT — 80 e2e tests across 13 suites, 6 unit tests]**

- **Unit**: `src/rbac/permissions.service.spec.ts` — the DENY-wins-over-ALLOW resolution logic,
  against a mocked Prisma client (no DB needed).
- **E2E** (`test/*.e2e-spec.ts`, run via `npm run test:e2e` against a dedicated `mygymagent_test`
  database, migrated and seeded by `test/global-setup.ts`) — 13 suites, headline ones:
  - `app.e2e-spec.ts` — health check.
  - `auth.e2e-spec.ts` — register/login/refresh-rotation/logout/me, wrong-password and
    unknown-email give identical responses, account lockout after repeated failures.
  - `tenant-isolation.e2e-spec.ts` — **the most important test in the codebase**: two real
    organizations, asserting Tenant A can never read/list/update/delete Tenant B's branches,
    members, membership plans, or memberships, including by guessing ids and by injecting a
    foreign `organizationId` into a request body.
  - `branch-scoping.e2e-spec.ts` / `member-assignment-scoping.e2e-spec.ts` — branch-scoped and
    trainer-assigned-only RBAC, see §6.
  - `rate-limiting.e2e-spec.ts` — asserts real `429`s past the tight per-route throttle limits.
  - `platform.e2e-spec.ts` — cross-tenant platform-admin surface, including audit attribution.
  - `ai.e2e-spec.ts` — the tool executor never leaks cross-org data, rejects malformed/cross-org
    tool arguments, and (as of the AI usage-tracking work) logs an `AiUsageLog` row on failure.
- **[PLANNED]** Structured-output validation tests, prompt-injection resistance against a *live*
  model (today's AI tests exercise the tool executor directly, not a real model call — no API key
  configured in the test environment), load/performance testing at scale, frontend/backend contract
  tests. See `docs/testing/strategy.md` and `docs/architecture/discovery-report.md` §16 for the full
  honest gap list.

## 19. Deployment architecture **[BUILT]**

Deployed: Render (this API) + Vercel (`mygymagent-f`) + Supabase (Postgres) — see
`docs/deployment/overview.md` for the auto-migrate-on-boot behavior (`npm start` runs
`prisma migrate deploy` before starting the server) and its one known sharp edge (concurrent
migrations if the API ever scales to multiple instances). `.github/workflows/ci.yml` runs CI.
One implementation note worth recording: Prisma 7's default `prisma-client` generator produces a
raw-TypeScript, ESM-only client (it uses
`import.meta.url`) that is fundamentally incompatible with being `require()`'d from a CommonJS
Node process — every combination of `ts-node`, `tsx`, and plain compiled output was tried and each
hit the same `import.meta` vs. CJS conflict. This project pins `prisma`/`@prisma/client` to the
stable v6 line with the classic `prisma-client-js` generator, which is a well-supported, boring,
CJS-compatible choice appropriate for a production NestJS service. Revisit once the ecosystem
(NestJS, ts-jest, tsx) has settled on Prisma 7 interop.

## 20. Observability architecture **[BUILT: basics + error tracking. PLANNED: metrics/tracing]**

`GET /health` (public) checks live DB connectivity (`SELECT 1`) and reports status/latency —
suitable for a container orchestrator's liveness/readiness probe. Every request carries a
correlation id (`RequestIdMiddleware`, echoed in the `x-request-id` response header and included in
every success envelope, error envelope, and audit log row), so a single request can be traced
across logs, error responses, and the audit trail. NestJS's built-in `Logger` is used for
structured server-side logging (5xx errors logged with the request id and stack trace).
**Error tracking**: `AllExceptionsFilter` reports every 5xx to Sentry (`src/instrument.ts`,
`SENTRY_DSN` env var — a no-op when unset, so this stays optional per deployment) tagged with the
request id, so a production 5xx is now visible without a user report, not just in server logs.
AI usage/cost is tracked per-request (`AiUsageLog`, §9) but not yet surfaced as a metric/dashboard.
**[PLANNED]** API latency percentiles, queue health metrics (once a queue exists), and distributed
tracing.

---

## Repository map

```
src/
  instrument.ts           Sentry init (imported first in main.ts) -- no-op without SENTRY_DSN
  auth/                   JWT + refresh-token auth, register/login/refresh/logout, password reset, email verification
  rbac/                   permission catalog, role catalog, PermissionsService, PermissionsGuard
  audit/                  AuditService (+ AuditInterceptor lives in common/)
  events/                 domain event catalog (EventEmitter2-backed)
  prisma/                 PrismaService (the only place PrismaClient is constructed)
  common/                 guards, decorators, interceptors, filters, middleware, mailer stub, pagination helpers
  organizations/          org profile + settings
  branches/               branch CRUD
  users/                  staff invite/list/update/deactivate, role assignment
  members/                gym client CRUD (flat Member model -- no Member 360 sub-entities yet)
  membership-plans/       plan CRUD
  memberships/            sell/freeze/resume/cancel a member's subscription
  attendance/             check-in/check-out
  billing/                gym-side Payment/Refund (platform SaaS billing still unbuilt)
  workouts/               exercises, workout plans, assignments
  nutrition/              food items, diet plans, assignments
  crm/                    leads + follow-ups
  inventory/              products + stock movements
  ai/                     v1 tool-calling chat over OpenRouter, AiUsageLog tracking -- see src/ai/README.md
  platform/               cross-tenant platform-admin surface (org list/status)
  notifications/ files/ search/ analytics/
                          reserved module seams -- see each directory's README.md
prisma/
  schema.prisma           the full data model
  seed.ts                 idempotent: seeds the permission catalog + system roles
test/
  *.e2e-spec.ts            13 suites -- auth, tenant isolation, branch scoping, assignment scoping,
                           rate limiting, platform admin, AI tool executor, and the core domain modules
```

See `docs/architecture/discovery-report.md` for the current, dated gap analysis this summary
doesn't repeat in full (Member 360 depth, PT-as-commerce, Assessments/Goals/Appointments, durable
job queue, platform billing, and more).
