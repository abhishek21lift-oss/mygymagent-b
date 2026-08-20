# Security architecture

## Authentication
JWT access token (15 min default) + opaque, sha256-hashed, rotating refresh token in an `httpOnly`
cookie. See ADR 0002 for the full rationale. Account lockout after repeated failed logins
(`User.failedLoginAttempts`/`lockedUntil`). Login failure messages never reveal whether an email
exists in the system.

## Authorization (RBAC)
- Permissions are `resource.action` strings (46 in the catalog, `src/rbac/permissions.catalog.ts`).
- Roles are either system-seeded (available to every org) or organization-custom
  (`Role.organizationId` set). 14 system roles ship today (`src/rbac/roles.catalog.ts`), including
  `PLATFORM_OWNER`/`PLATFORM_ADMIN` — **note:** these two exist in the catalog and on
  `User.platformRole` but nothing currently assigns them; there is no cross-tenant platform-admin
  capability wired up yet (no bootstrap flow, no endpoint bypasses `organizationId` scoping). Building
  that is future work, not a hidden feature.
- Roles can be assigned org-wide or scoped to a single branch (`UserRole.branchId`).
- Per-user `ALLOW`/`DENY` overrides layer on top of role-derived permissions; **DENY always wins**,
  so an admin can carve out an exception without redesigning the role graph.
- Enforced by `PermissionsGuard` + `@RequirePermission()`, backed by
  `PermissionsService.hasPermission()`.

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
| Trainer → unauthorized member (a trainer reading a member not assigned to them) | ⚠️ Not yet a dedicated test — the same `organizationId`-scoping mechanism applies, but assignment-level scoping (trainer can only see *their* assigned members within their own org) isn't separately verified |
| Branch user → another branch (within the same org) | ⚠️ Not yet a dedicated test — `UserRole.branchId` scoping exists in the schema/RBAC model but isn't exercised by an e2e test yet |
| AI agent → unauthorized data | N/A — `ai` module not built; see `docs/ai/architecture.md` for the intended tool-scoping model |
| Malicious upload / unauthorized file access | N/A — `files` module not built |
| Prompt injection | N/A — no AI/LLM integration exists yet |
| Rate abuse | ⚠️ Throttler is configured and manually verified via the tight per-endpoint auth limits, but no e2e test asserts a `429` is actually returned after exceeding a limit |

The unchecked rows above are the honest gap list — call them out explicitly rather than claiming a
security review passed when it only covers what's listed as ✅.
