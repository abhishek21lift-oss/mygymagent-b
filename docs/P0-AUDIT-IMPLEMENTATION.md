# P0 Security / Tenant-Isolation Audit — Implementation

## Confirmed findings fixed on this branch

### P0-SEC-01 — Combined permission branch-scope loss
`PermissionsGuard` previously reset `branchScope` to `null` when a later AND-required permission was org-wide. A route requiring both a branch-scoped permission and an org-wide permission could therefore lose the branch restriction before the handler ran.

**Fix:** branch-scoped grants are now sticky across all AND-required permissions. An org-wide permission can never clear a branch restriction already established by another required permission.

**Regression coverage:** `src/common/guards/permissions.guard.spec.ts`.

### P0-SEC-02 — Unsafe production environment fallbacks
Production configuration previously inherited development-safe defaults such as localhost CORS/Redis and accepted 16-character/placeholder JWT secrets.

**Fix:** production validation now rejects:
- JWT secrets shorter than 32 characters
- known placeholder JWT secrets
- localhost database URLs
- localhost Redis URLs
- non-HTTPS CORS origins
- localhost/non-HTTPS frontend URLs

**Regression coverage:** `src/config/env.validation.spec.ts`.

## Existing controls verified during audit

- Global deny-by-default JWT authentication.
- Database-backed user lookup on every authenticated request, so suspension and role changes are effective immediately.
- Organization scope is taken from the authenticated user, not client-supplied organization IDs.
- Branch scope is reconciled through server-side permission checks before being passed to domain services.
- AI tools use the authenticated user's organization context and re-derive resource permissions rather than trusting model-supplied tenant context.
- High-risk AI actions require human approval plus the underlying domain permission before execution.
- Cookie-authenticated refresh/logout endpoints enforce Origin allowlisting.

## Verification requirement

This branch must not be declared P0-complete until CI passes typecheck, lint, unit tests, E2E tests, build, and Docker build. VPS verification must then confirm the same commit is deployed and health/readiness checks succeed.
