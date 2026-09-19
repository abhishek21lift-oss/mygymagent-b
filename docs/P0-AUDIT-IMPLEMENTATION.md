# P0 Security / Tenant-Isolation Audit — Implementation

Originally carried out on `p0/security-production-foundation`. Both code
fixes below are ported onto this line, each with its regression spec
verified to fail against the unfixed code and pass against the fixed code.

## Confirmed findings fixed

### P0-SEC-01 — Combined permission branch-scope loss

`PermissionsGuard` recomputed `branchScope` per required permission and
reset it to `null` for any org-wide one:

```ts
branchScope = orgWide ? null : (branchId ?? branchScope);
```

A route requiring both a branch-scoped and an org-wide permission therefore
lost the branch restriction before the handler ran — the caller reached
every branch's data. A privilege-escalation path.

**Fix:** a branch-scoped grant latches (`branchScopedGrant`) and no later
permission can clear it. The OR branch only adds a restriction when the
matched permission is itself branch-scoped, and never clears one the AND
list established.

**Regression coverage:** `src/common/guards/permissions.guard.spec.ts`.

### P0-SEC-02 — Unsafe production environment fallbacks

Production inherited development-safe defaults — localhost database and
Redis, plaintext origins — and accepted 16-character or placeholder JWT
secrets. Nothing stopped a production boot on any of them.

**Fix:** `envSchema.superRefine` fails boot when `NODE_ENV=production` and
any of these hold:

- JWT access/refresh secret under 32 characters
- a JWT secret matching a known `.env.example` placeholder
- `DATABASE_URL` or `REDIS_URL` pointing at localhost
- a `CORS_ORIGIN` allowlist entry that is not HTTPS or not a valid URL
- `FRONTEND_URL` on localhost, not HTTPS, or not a valid URL

`CORS_ORIGIN` is optional on this line (`main.ts` falls back to a hardcoded
HTTPS origin and warns when unset), so only an explicitly configured value
is checked.

**Regression coverage:** `src/config/env.validation.spec.ts`.

## Existing controls verified during audit

- Global deny-by-default JWT authentication.
- Database-backed user lookup on every authenticated request, so suspension
  and role changes take effect immediately.
- Organization scope is taken from the authenticated user, never from a
  client-supplied organization ID in a body or query param.
- Branch scope is reconciled through server-side permission checks before
  being passed to domain services.
- AI tools use the authenticated user's organization context and re-derive
  resource permissions rather than trusting model-supplied tenant context.
- High-risk AI actions require human approval plus the underlying domain
  permission before execution.
- Cookie-authenticated refresh/logout are protected by the app-level CORS
  allowlist (`enableCors` with `credentials: true` in `main.ts`), not a
  per-endpoint Origin check. Note this is browser-enforced only — it stops
  cross-origin browser CSRF, not a non-browser client replaying a stolen
  cookie.

## Verification requirement

Not P0-complete until CI passes typecheck, lint, unit tests, E2E tests,
build and Docker build, and deployment verification confirms the same
commit is live with health/readiness checks succeeding.

## Known gaps on this line

- `analytics-intelligence` and `daily-briefing` E2E specs fail on this
  branch, independent of the fixes above (confirmed against a clean
  baseline). They need triage before a P0-complete claim.
