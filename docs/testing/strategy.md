# Testing strategy

## What exists today

| Layer | Tool | Coverage |
|---|---|---|
| Unit | Jest (`npm test`) | `PermissionsService` (`hasPermission`/`getEffectivePermissions`) — 6 tests. Deliberately thin so far: the "deep foundation" phase prioritized e2e coverage of tenant isolation and auth over unit-testing every service method, since the highest-risk surface (cross-tenant leaks) is best caught at the HTTP boundary, not by mocking Prisma. |
| Integration/E2E | Jest + Supertest, real Postgres (`npm run test:e2e`) | 17 tests across `auth.e2e-spec.ts`, `tenant-isolation.e2e-spec.ts`, `app.e2e-spec.ts` (health/ready). Runs against a real database (migrated + seeded fresh each run via `test/global-setup.ts`), not mocks — this is intentional: tenant-isolation bugs live in the interaction between the Prisma `where` clause and the DB, which a mocked Prisma client can't catch. |
| Security | Same e2e suite | See `docs/security/overview.md`'s test matrix for the exact checklist and what's not yet covered (branch-scoping, AI-agent access, upload safety, prompt injection, rate-limit enforcement). |
| Tenant isolation | `tenant-isolation.e2e-spec.ts` | Two full organizations created per test run, cross-org access attempted from every angle the current domain surface allows (read, write, create-with-foreign-reference, forged tenant ID, missing permission). |
| AI evaluation | N/A | No AI module exists yet. |

## What's not built yet (honest gaps)

- **Performance/load testing.** No test exercises the platform at the §65 target scale (10,000+
  members/org, millions of attendance/financial rows). The schema's indexes
  (`docs/database/erd.md`) are designed with that scale in mind (composite indexes on
  `[organizationId, branchId, checkInAt]` etc.), but "designed for" and "verified against" are
  different claims — a load test against a seeded large dataset is future work, not done.
- **Contract tests** between frontend and backend — see ADR 0005's "keeping frontend and backend in
  sync" section; today this is manual discipline, not an automated check.
- **Mutation testing / coverage thresholds** — `test:cov` exists (`jest --coverage`) but nothing
  enforces a minimum in CI yet.
- **AI evaluation harness** — will be needed once the `ai` module is built (structured-output
  validation tests, prompt-injection resistance tests, tool-permission-boundary tests). See
  `docs/ai/architecture.md`.

## Principle going forward

Every new domain that gets built (not just documented) needs, before it's considered done:
1. Unit tests for any non-trivial business logic (pricing, scheduling, eligibility rules).
2. An e2e test proving tenant isolation holds for its new tables/endpoints — copy the pattern in
   `tenant-isolation.e2e-spec.ts`, don't invent a new one.
3. A security-relevant addition to `docs/security/overview.md`'s test matrix if it introduces a new
   category of access (e.g. file upload → add "malicious upload" as ✅ once actually tested, not
   before).

"Tests pass" is necessary but not sufficient — a green suite that never attempted a cross-tenant
read proves nothing about tenant isolation. The gaps list above exists so that claim never gets made
implicitly by omission.
