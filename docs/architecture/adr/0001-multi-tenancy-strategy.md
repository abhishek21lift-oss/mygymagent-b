# ADR 0001: Multi-tenancy via shared schema + mandatory `organizationId`

## Status
Accepted, implemented.

## Context
The platform serves many gyms (organizations) from one deployment. We need tenant isolation that
holds up under 1000s of tenants and doesn't leak data across them.

## Options considered
1. **Database-per-tenant** — strongest isolation, but migration/ops overhead scales linearly with
   tenant count; unworkable at "thousands of gyms."
2. **Schema-per-tenant** (Postgres schemas) — better than DB-per-tenant but still doesn't scale
   migration tooling past a few hundred tenants cleanly, and Prisma's migration tooling assumes one
   schema.
3. **Shared schema, `organizationId` column on every tenant-owned table** — one schema, one
   migration history, isolation enforced in the application layer.

## Decision
Shared schema with a mandatory `organizationId` foreign key on every tenant-owned table.

Enforcement is structural, not a checklist item:
- `organizationId` is taken **only** from the authenticated JWT (`@CurrentUser()`), never from
  client-supplied input. `ValidationPipe({ forbidNonWhitelisted: true })` rejects any request body
  that tries to set it explicitly (verified by `test/tenant-isolation.e2e-spec.ts`).
- Every service method's Prisma `where` clause includes `organizationId` alongside the record `id` —
  there is no separate "check ownership after fetch" step, which would create a window for a
  404-vs-403 side channel (an attacker could otherwise infer another tenant's record exists by
  getting a 403 instead of a 404).
- Branch-level scoping (`branchId`, nullable) layers on top for branch-scoped roles.

## Trade-offs
- Every new table needs its author to remember to add and index `organizationId` — mitigated by
  code review and the tenant-isolation e2e suite, not by the schema alone.
- A single noisy-neighbor tenant with a huge dataset shares infrastructure with everyone else — an
  Enterprise tier could later be moved to a dedicated read replica or partition if needed, without
  changing the isolation model.
- Cross-tenant analytics/reporting (for the platform operator) is easy to write correctly and easy
  to write incorrectly — every such query needs explicit review since there's no schema boundary
  stopping an accidental cross-tenant join.

## Consequences
Verified today by `test/tenant-isolation.e2e-spec.ts`: Tenant A cannot read/write Tenant B's
members, forging `organizationId` in a request body is rejected at the validation layer, and
permission checks are evaluated against the JWT's tenant, not any client-supplied one.
