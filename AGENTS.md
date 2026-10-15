# mygymagent-b — Backend API (NestJS 11 + Prisma 6 + PostgreSQL)

See the workspace root `../AGENTS.md` (actual workspace root: `/home/oem/Desktop/tcc`)
for shared architecture, multi-tenant, database, security, testing, and Git rules.
Project skills: `mygymagent-backend`, `mygymagent-backend-ops`
(global: `nestjs-saas-backend`, `gym-saas-domain`, `security-supabase-rls`, `testing-qa`).

## Repo essentials

- Modules in `src/` (`auth/`, `rbac/`, `payments/`, `billing/`, `whatsapp*/`, `queue/`, `prisma/`, …);
  schema in `prisma/schema.prisma`, migrations in `prisma/migrations/`.
- Commands (run from here): `npm run start:dev`, `npm run build`,
  `npm run typecheck`, `npm run lint:ci`, `npm test`, `npm run test:e2e` (`.env.test` only),
  `npm run db:check-drift`, `npm run db:seed:*`.
- Tenant context is derived per request: JWT validated in
  `auth/strategies/jwt.strategy.ts`, user + organization re-read from the DB,
  threaded explicitly as `user.organizationId` with `@CurrentBranchScope()`
  enforcement — never from client-supplied IDs, and not via `nestjs-cls`
  (which this codebase does not use). Authorize every object
  (tenant + role + branch/assignment scope).
- Background work via BullMQ (`src/queue/`); idempotent jobs with retries.
  Webhook signatures verified with raw body before parsing.
- Never commit, push, or run production migrations without explicit authorization.
