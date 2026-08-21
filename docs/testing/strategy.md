# Testing strategy

## What exists today

| Layer | Tool | Coverage |
|---|---|---|
| Unit | Jest (`npm test`) | `PermissionsService` (`hasPermission`/`getEffectivePermissions`) — 6 tests. Deliberately thin so far: e2e coverage of tenant isolation and auth was prioritized over unit-testing every service method, since the highest-risk surface (cross-tenant leaks) is best caught at the HTTP boundary, not by mocking Prisma. |
| Integration/E2E | Jest + Supertest, real Postgres, real Redis, **and real S3-protocol server (`s3rver`)** (`npm run test:e2e`) | 107 tests across 17 suites — `auth`, `tenant-isolation`, `branch-scoping`, `member-assignment-scoping`, `rate-limiting`, `platform`, `ai`, `member-360`, `member-assessments-goals`, `member-documents`, `notifications-queue`, `app` (health), and the core domain modules. Runs against a real database (migrated + seeded fresh each run via `test/global-setup.ts`), a real Redis, and a real `s3rver` instance (CI provisions Postgres/Redis as service containers and starts `s3rver` as a background process, see `.github/workflows/ci.yml`) — not mocks: tenant-isolation bugs live in the interaction between the Prisma `where` clause and the DB, the queue tests assert a job actually completes via a real BullMQ worker, and the file-upload tests assert a real object round-trips through real S3-protocol requests, none of which a mock would catch. |
| Security | Same e2e suite | See `docs/security/overview.md`'s test matrix for the exact checklist and what's not yet covered (prompt injection against a live model). |
| Tenant isolation | `tenant-isolation.e2e-spec.ts` | Two full organizations created per test run, cross-org access attempted from every angle the current domain surface allows (read, write, create-with-foreign-reference, forged tenant ID, missing permission). |
| AI evaluation | Partial | `ai.e2e-spec.ts` exercises the tool executor directly (no live model needed) — cross-tenant leak prevention, malformed/cross-org tool arguments, and (since the usage-tracking work) that a failed provider call still logs an `AiUsageLog` row. Still missing: structured-output validation tests and prompt-injection resistance against a real model call, which need a configured `OPENROUTER_API_KEY` the test environment doesn't have. |

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
- **AI evaluation harness against a live model.** Tool-permission-boundary tests exist
  (`ai.e2e-spec.ts`, against the tool executor directly). Structured-output validation tests and
  prompt-injection resistance tests still need a real model call, which needs a configured
  `OPENROUTER_API_KEY` in the test environment — not set up yet. See `docs/ai/architecture.md`.

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
