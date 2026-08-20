# MyGymAgent — API

NestJS + PostgreSQL (Prisma) backend for the MyGymAgent multi-tenant gym management platform.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full technical blueprint — what's
built, what's deliberately deferred, and how each domain is meant to attach to what's here. See
**[docs/README.md](docs/README.md)** for the full documentation index (ADRs, database, API, security,
deployment, testing, and design docs for domains not built yet).

## Stack

- NestJS 11 + TypeScript
- PostgreSQL via Prisma 6 (`prisma-client-js`)
- JWT access tokens + opaque, rotating, hashed refresh tokens
- RBAC with `resource.action` permissions, org- and branch-scoped role assignment
- `class-validator`/`class-transformer` DTOs, global `ValidationPipe`
- Jest + Supertest for unit/e2e tests

## Local setup

Requires Node 20+ and a local PostgreSQL instance.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and JWT secrets
npx prisma migrate dev      # creates the schema
npm run db:seed             # seeds the permission catalog + system roles
npm run db:seed:dev         # optional: adds a full demo org/branches/staff/members (dev only, never production)
npm run start:dev
```

Or via Docker Compose (Postgres + API, no local Node/Postgres install required):

```bash
docker compose up
```

The API listens on `PORT` (default `4000`). `GET /health` is a liveness check (process up, no
dependency checks); `GET /ready` additionally checks DB connectivity and returns `503` if the
database is unreachable — see `docs/deployment/overview.md`.

## Testing

```bash
npm test        # unit tests
npm run test:e2e  # e2e tests against a *separate* database (DATABASE_URL in .env.test),
                   # auto-migrated and seeded by test/global-setup.ts
```

`test/tenant-isolation.e2e-spec.ts` is the most important suite in the repo: it proves one
organization can never read, list, modify, or delete another organization's data.

## Auth flow (for the frontend)

- `POST /auth/register` — creates a brand-new Organization + its first Branch + the caller as
  Owner. Returns `{ user, organization, accessToken }` and sets an `httpOnly` refresh cookie.
- `POST /auth/login` — same response shape.
- `POST /auth/refresh` — reads the refresh cookie, rotates it, returns a new access token.
- `POST /auth/logout` / `POST /auth/logout-all` — revoke the current / all refresh tokens.
- `GET /auth/me` — current user + effective permission list (for permission-aware navigation).
- `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/verify-email`.

Every other endpoint requires `Authorization: Bearer <accessToken>`. Send `x-branch-id` to scope a
request to a specific branch where relevant (e.g. filtering members/attendance by branch).

## Platform administration (managing gyms, not gym members)

There is no default super-admin account, and none can be created via `/auth/register` — that flow
only ever creates an org-scoped owner for a *new* organization. To control organizations
(gyms) across the whole platform — list them, suspend/reactivate one, etc. — you need a platform
admin account, created once, out-of-band:

```bash
npm run platform:create-admin -- \
  --email=you@example.com --password='...' --firstName=Jane --lastName=Doe
```

Then log in normally at `POST /auth/login` with that email/password. A platform admin's token
unlocks `GET /platform/organizations`, `GET /platform/organizations/:id`, and
`PATCH /platform/organizations/:id/status` — every other endpoint is unaffected (a platform admin
has no organization, so org-scoped endpoints like `/members` don't apply to them). See
`docs/security/overview.md`'s "Platform administration" section for how this is guarded, and
`src/platform/` for the code.

## Response shape

Success: `{ "data": <payload>, "meta": { "requestId": "..." } }`
Error: `{ "error": { "code": "...", "message": "...", "details"?: ..., "requestId": "..." } }`

See **[docs/api/conventions.md](docs/api/conventions.md)** for the full rundown (pagination, status
codes, versioning).

## Deployment

`Dockerfile` + `docker-compose.yml` (local dev) live in this repo; `.github/workflows/ci.yml` runs
typecheck/lint/unit/e2e/build/Docker-build on every push. See
**[docs/deployment/overview.md](docs/deployment/overview.md)** for environments, migration strategy,
rollback approach, and how this repo is actually deployed today.
