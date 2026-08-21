# Security architecture

## Authentication
JWT access token (15 min default) + opaque, sha256-hashed, rotating refresh token in an `httpOnly`
cookie. See ADR 0002 for the full rationale. Account lockout after repeated failed logins
(`User.failedLoginAttempts`/`lockedUntil`). Login failure messages never reveal whether an email
exists in the system.

The refresh cookie's `SameSite`/`Secure` attributes switch on `NODE_ENV` (`AuthController.cookieOptions()`):
`None`+`Secure` in production, `Lax` (no `Secure`) otherwise. This isn't a style choice -- frontend
(Vercel) and backend (Render) are different registrable domains in production, so the browser
treats every `fetch(..., {credentials: 'include'})` call to the API (including the silent-refresh-
on-page-load call every client makes) as cross-site. `SameSite=Lax` cookies are withheld from
cross-site fetch/XHR entirely (they only ride along on top-level navigation), so a `Lax` refresh
cookie in this split-domain deployment would never actually reach `/auth/refresh` -- every page
reload would silently fail to restore the session and bounce the user back to `/login`. `None`
requires `Secure`, which is why the switch is tied to `NODE_ENV` rather than always-on: local dev
serves over plain `http://localhost`, where a `Secure` cookie either gets rejected outright or only
works through browser-specific localhost exceptions, and `Lax` doesn't need it there anyway since
frontend/backend share the `localhost` site (port isn't part of site identity for this purpose).

## Authorization (RBAC)
- Permissions are `resource.action` strings (47 in the catalog, `src/rbac/permissions.catalog.ts`).
- Roles are either system-seeded (available to every org) or organization-custom
  (`Role.organizationId` set). 14 system roles ship today (`src/rbac/roles.catalog.ts`), including
  `PLATFORM_OWNER`/`PLATFORM_ADMIN`.
- **Platform administration** is a deliberately separate path from org-scoped RBAC, not an
  extension of it: `PermissionsService.hasPermission()` always returns `false` for a null
  `organizationId`, so a platform user can never accumulate access via the normal permission system.
  Instead, `User.platformRole` is checked directly by `PlatformRoleGuard` +
  `@RequirePlatformRole()`, gating the cross-tenant endpoints under `/platform/*`
  (`src/platform/`) — currently: list all organizations, read one, change its status
  (`TRIAL`/`ACTIVE`/`SUSPENDED`/`CANCELLED`). These are the only endpoints in the codebase that
  don't scope by the caller's own `organizationId`; see `PlatformOrganizationsService`'s class
  comment and ADR 0001's trade-offs section. A platform action is recorded in `AuditLog` against
  the *target* organization, not the actor's (null) one — done explicitly in the service, not via
  `@Audited()`, since that interceptor would otherwise misfile it under no organization.
- No platform admin exists by default and none can be created through `/auth/register` or any
  other HTTP endpoint — deliberately, since platform-admin access must never be self-service. Create
  one with `npm run platform:create-admin -- --email=... --password=... --firstName=... --lastName=...`
  (`prisma/create-platform-admin.ts`), run manually against the target database.
- Roles can be assigned org-wide or scoped to a single branch (`UserRole.branchId`). A branch-scoped
  grant is enforced two ways: `PermissionsGuard` denies the request outright unless the caller sends
  the matching `x-branch-id` header, and it also resolves *how* the permission was granted --
  org-wide or branch-only -- exposing that as `request.branchScope` (see the guard's class comment).
  Every service method that touches a branch-scoped resource (Members, Attendance, Memberships,
  Payments, Leads, Users/staff) folds that into its `where` clause and into any client-supplied
  `branchId` on create/update, the same way `organizationId` is already mandatory everywhere. Users
  gets one extra rule on top: a branch-scoped grantor (someone whose own `users.create`/
  `manage_roles` grant is itself branch-scoped) can only invite staff into, or hand out role grants
  scoped to, their own branch -- never org-wide or another branch -- so branch scoping can't be used
  to escalate past itself.
- Per-user `ALLOW`/`DENY` overrides layer on top of role-derived permissions; **DENY always wins**,
  so an admin can carve out an exception without redesigning the role graph.
- Enforced by `PermissionsGuard` + `@RequirePermission()`, backed by
  `PermissionsService.hasPermission()`.
- **Assignment-level scoping** for Members: `@RequireAnyPermission('members.read',
  'members.read_assigned')` (the OR counterpart to `@RequirePermissions()`, same file) lets a route
  be reachable through either the broad `members.read` or the narrower `members.read_assigned`, and
  records which one actually matched as `request.grantedViaPermission`. The TRAINER role holds only
  the narrower key, so `MembersService` filters to `assignedTrainerId === caller.id` whenever that's
  how access was granted (`@CurrentAssignmentScope()`), the same pattern `branchScope` uses for
  branches. NUTRITIONIST is deliberately **not** on `members.read_assigned` -- its "assigned clients"
  relationship is `DietAssignment.assignedByUserId`, not `Member.assignedTrainerId`, and scoping it
  correctly needs a join this mechanism doesn't do; see the comment on that role in
  `roles.catalog.ts`.

## Tenant isolation
See ADR 0001. `organizationId` comes only from the verified JWT, never from client input; every
service method's Prisma `where` includes it; a cross-tenant read returns `404`, never `403` (so a
caller can't distinguish "doesn't exist" from "exists but isn't yours").

## Audit logging
`@Audited()` decorator + a global interceptor write to `AuditLog` for permission-relevant mutations
(role/permission changes, member/membership changes, auth events). Rows are never updated or
deleted by application code — see `docs/database/data-retention.md`.

## Input validation
Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` — any field not on the DTO
is rejected outright, not stripped silently. This is what makes the "can't inject `organizationId`"
guarantee structural rather than something every DTO author has to remember.

## File uploads
`MemberDocumentsService` (`src/members/`) enforces a MIME-type allowlist (JPEG/PNG/WebP/PDF) and a
10MB size cap before anything reaches S3-compatible storage — an unsupported type or oversized file
is rejected with `400` before an upload is attempted, not after. Object keys are never returned to
a client; every read goes through `FileStorageService.getSignedUrl()`, generated fresh per request
with a 15-minute expiry, so a leaked URL self-expires and storage credentials/bucket structure are
never exposed. Access to a specific member's documents is enforced the same way as the rest of
Member 360 (tenant/branch/assignment scoping via `MembersService.getOne()`), not a separate
files-specific permission check that could drift out of sync with it. See `src/files/README.md`.

## Rate limiting
Global throttle (120 req/min per client) via `@nestjs/throttler`, with tighter per-endpoint limits
on `/auth/register` (5/min), `/auth/login` (20/min), and `/auth/forgot-password` (5/min — deliberately
tight since it triggers an email send). `/auth/refresh` and `/auth/logout` use the global limit
only. See `src/auth/auth.controller.ts` for the authoritative numbers.

## Transport/headers
`helmet()` for standard security headers, `compression()`, CORS locked to a configured origin list
(`CORS_ORIGIN`) with `credentials: true` (required for the cross-origin refresh cookie flow — see
`mygymagent-f/README.md`).

## Security test matrix (§64) — what's covered today vs. not yet

| Test | Status |
|---|---|
| Tenant A → Tenant B read/write (org, branch, member, membership, attendance) | ✅ `test/tenant-isolation.e2e-spec.ts` |
| Forged tenant ID in request body | ✅ same file — rejected at validation layer (400), not silently dropped |
| User without permission → restricted endpoint | ✅ same file |
| Expired/garbage session → API | ✅ `test/auth.e2e-spec.ts` |
| Refresh token rotation + reuse-after-rotation detection | ✅ `test/auth.e2e-spec.ts` |
| Account lockout after repeated failed logins | ✅ `test/auth.e2e-spec.ts` |
| Trainer → unauthorized member (a trainer reading a member not assigned to them) | ✅ `test/member-assignment-scoping.e2e-spec.ts` — a TRAINER's member list/detail endpoints only return members where `assignedTrainerId` is their own id; a broad `members.read` holder (e.g. the org owner) is unaffected. NUTRITIONIST is a documented exception, not covered — see the RBAC section above |
| Branch user → another branch (within the same org) | ✅ `test/branch-scoping.e2e-spec.ts` — a manager whose only grant is scoped to Branch A is denied outright without the `x-branch-id` header, and with it still can't create/read/update/list/pay/check-in against Branch B's data, across Members, Payments, Attendance, Leads, and Users/staff (including that a branch-scoped grantor can't hand out an org-wide or other-branch role) |
| AI agent → unauthorized data | ✅ `test/ai.e2e-spec.ts` — the tool executor is exercised directly (no live model needed): `read_member` never returns another org's member or raw PII fields, and `create_workout_draft`/`create_diet_draft` reject a cross-org exercise/food-item reference. See `docs/ai/architecture.md` for the tool-scoping model |
| Malicious upload / unauthorized file access | ✅ `test/member-documents.e2e-spec.ts` — a MIME-type allowlist + 10MB size cap reject an unsupported/oversized upload (400), cross-tenant access is denied the same way as the rest of Member 360 (404 via `MembersService.getOne()`), and every read goes through a signed URL generated fresh per request (never a stored/permanent one) — see `src/files/README.md` |
| Prompt injection | ⚠️ Not yet a dedicated test — the tool allowlist + per-tool argument validation (`class-validator`) structurally bound what a model can do regardless of what it's told (see `test/ai.e2e-spec.ts`'s tool-executor tests), but no test drives a crafted prompt through a live model end-to-end to confirm that holds in practice; that requires a real `OPENROUTER_API_KEY`, which isn't configured for this test environment |
| Rate abuse | ✅ `test/rate-limiting.e2e-spec.ts` — asserts a real `429` after exceeding the tight `/auth/register` and `/auth/forgot-password` limits, and that a handful of calls to an unthrottled route never trips the global 120/min limit |
| Cross-tenant Member 360 access (addresses/emergency contacts/notes/consents/status-branch-trainer history) | ✅ `test/member-360.e2e-spec.ts` — org B gets `404` reading or writing org A's member sub-resources, since every `MemberDetailsService`/`MembersService` history method re-runs the same `MembersService.getOne()` tenant/branch/assignment scoping the parent Member route uses, never a bare id lookup |
| Ordinary org user → `/platform/*` (cross-tenant admin surface) | ✅ `test/platform.e2e-spec.ts` — also verifies unauthenticated access is rejected, and that a platform action's audit entry is attributed to the target org, not the actor's null one |

The unchecked rows above are the honest gap list — call them out explicitly rather than claiming a
security review passed when it only covers what's listed as ✅.
