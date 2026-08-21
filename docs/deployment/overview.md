# Deployment architecture

## Environments

| Environment | `NODE_ENV` | Database | Purpose |
|---|---|---|---|
| Development | `development` | Local Postgres (via `docker-compose.yml`) or a dedicated dev cloud DB | Local iteration, `npm run start:dev` (hot reload) |
| Staging | `staging` | Separate managed Postgres instance from production | Pre-production verification; same image/build pipeline as production |
| Production | `production` | Managed Postgres (currently Supabase; see ADR below) | Live traffic |

`NODE_ENV` only ever gates a small number of code paths today (e.g. cookie `secure` flag in
`auth.controller.ts`) — staging and production are otherwise identical builds, differing only in
environment variables and the database they point at. This is deliberate: a build that behaves
differently per environment beyond config is a build you haven't actually tested before it reaches
production.

## How this repo is actually deployed right now

- **Backend** (`mygymagent-b`): deployed to Render as a Node web service. Build command
  `npm install --include=dev && npm run build`, start command `npm start`
  (`prisma migrate deploy && node dist/src/main`) — `--include=dev` is required because `@nestjs/cli`
  and the TypeScript toolchain live in `devDependencies`, and Render's `npm install` skips those when
  `NODE_ENV=production` is set (it is, for the running service).
- **Frontend** (`mygymagent-f`): deployed to Vercel, which builds and serves the Next.js app
  natively — the `Dockerfile` in this repo exists for a Docker-based host as an alternative, not
  because Vercel uses it.
- **Database**: a pre-existing Supabase Postgres project, connected to directly via its connection
  pooler (`DATABASE_URL`), not through the Supabase client SDK — this app talks to Postgres with
  Prisma exactly as it would to any other managed Postgres.

## Docker

- `mygymagent-b/Dockerfile`: multi-stage (deps → build → prod-deps → runtime), non-root user,
  built-in `HEALTHCHECK` hitting `/health`, final image contains only `dist/`, production
  `node_modules`, and the Prisma schema (needed at runtime for the query engine).
- `mygymagent-f/Dockerfile`: multi-stage, uses Next.js's `output: 'standalone'` (set in
  `next.config.ts`) so the final image is just the standalone server + static assets, not the full
  `node_modules`/`.next` build tree. `NEXT_PUBLIC_API_URL` must be passed as a **build arg**
  (`docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .`), not a runtime env var —
  Next.js inlines `NEXT_PUBLIC_*` values into the client bundle at build time.
- `mygymagent-b/docker-compose.yml`: local-dev-only stack (Postgres + the API in watch mode with
  source bind-mounts). Not used for staging/production, which deploy the built image directly.

## CI/CD

`.github/workflows/ci.yml` in each repo, on push/PR: install → typecheck → lint → unit tests →
(backend only) e2e tests against a Postgres service container → build → Docker image build. Nothing
deploys automatically from CI yet — Render/Vercel each poll/webhook the repo directly for their own
auto-deploy on push to the tracked branch. If a dedicated deploy step is added later (e.g. deploying
to a non-Render/Vercel target), it should run only after the full CI job above passes, never as a
parallel/independent step.

## Database migrations

- All schema changes go through Prisma migrations (`prisma/migrations/`) — see ADR-less-but-firm
  rule in `docs/database/`: **no manual schema edits on staging/production**, ever.
- Development: `npm run prisma:migrate` (`prisma migrate dev`) — generates and applies a migration,
  interactive-safe for a local throwaway database.
- **Staging/production applies automatically on every boot.** `npm start` runs `prisma migrate
  deploy && node dist/src/main` (same for the Docker image's `CMD`) — pending migrations are applied
  non-interactively *before* the process starts accepting traffic, not as a manual step a human has
  to remember to run after merging a schema change. `prisma migrate deploy` never generates new
  migrations and is safe to run on every boot: it's a no-op when nothing is pending, and it takes an
  advisory lock so concurrent instances starting at once don't race. This is why `prisma` (the CLI,
  not just `@prisma/client`) lives in `dependencies`, not `devDependencies` — it has to be present at
  runtime now. `npm run prisma:migrate:deploy` still exists for running it by hand (e.g. to check
  what a migration will do before deploying the code that needs it).
- **Trade-off, deliberately accepted:** if a migration fails against the live database (a real SQL
  error, not just "nothing pending"), the `&&` means the app process never starts and the deploy
  fails loudly instead of serving traffic against a schema the code doesn't match. That's the
  correct failure mode for this app's size — investigate and fix the migration, then redeploy —
  rather than adding retry/skip logic that could silently leave schema and code out of sync.
- **Rollback strategy**: Prisma doesn't auto-generate down-migrations. A destructive or
  wrong migration is rolled back by writing and applying a new forward migration that reverses it
  (see the `drop_stray_member_branch_id` migration in this repo's own history for a real example —
  it was written to fix a schema mistake, not by editing or deleting the original migration file).
  Never edit or delete an already-applied migration file; the checksum Prisma tracks in
  `_prisma_migrations` will reject a modified file and desync every other environment that already
  applied the original.
- Avoid destructive migrations (dropping a column/table with data) without a two-step plan: (1)
  stop writing to the column/table in application code and deploy that first, (2) only once that's
  live and confirmed, ship the migration that actually drops it. A single migration that drops a
  column the currently-running application code still reads from will break production the instant
  it applies, regardless of how careful the SQL is.

## Health checks

- `GET /health` — liveness. No dependency checks. Use for "should this container be restarted."
- `GET /ready` — readiness (checks DB connectivity and the job queue's Redis connection, returns
  `503` if either is unreachable). Use for "should traffic be routed here." Render, Docker
  `HEALTHCHECK`, and any future orchestrator should point at `/health` for restart decisions and
  `/ready` (if the platform distinguishes the two) for traffic gating.

## Redis (job queue)

`src/queue/` (BullMQ) requires `REDIS_URL` — see `docs/ARCHITECTURE.md` §10.5 for what runs on it
today (one welcome-email job) and the deliberate choices behind it (in-process worker, unlimited
connection retries). **Production and staging must set a real `REDIS_URL`** pointing at a managed
Redis instance (a Render Redis add-on, Upstash, etc.) — unset, it defaults to
`redis://localhost:6379`, which doesn't exist on Render's containers. Unlike the database, a missing
Redis does not fail the boot or any request — `GET /ready` will report `queue: "down"` and return
`503`, which is the intended signal to notice and fix it, not a hard outage.

## Logging

Nest's built-in `Logger` today, going to stdout/stderr — correct for a platform (Render, Docker) that
captures container stdout as the log stream. `AllExceptionsFilter` logs every 5xx with its
`requestId` and full stack trace server-side, never in the client response. No structured
log aggregation (e.g. shipping to a log platform) is wired up yet — the current setup is
"correct baseline," not "production-observability-complete"; see
`docs/testing/strategy.md`'s observability gate for what's still missing (per-tenant cost/failure
attribution, retry visibility).

## Monitoring / backups

- **Monitoring**: not yet integrated (no APM/metrics export). `/ready`'s DB check and Render's own
  service-level health monitoring are the only signals today.
- **Backups**: delegated to the managed Postgres provider (Supabase's automatic backups). No
  application-level backup/export job exists yet — see `docs/import-export.md` for the related
  (but distinct) data-portability/export architecture, which is about user-initiated exports, not
  disaster-recovery backups.

## No manual server file edits

Nothing about this deployment depends on SSH-ing into a server and changing a file. Config changes
go through environment variables set in Render/Vercel's dashboards (or their CLIs); code changes go
through git + the CI pipeline; schema changes go through committed Prisma migrations. This is a
property worth protecting deliberately — it's easy to lose the first time someone "just quickly"
patches something directly on a running instance under deadline pressure.
