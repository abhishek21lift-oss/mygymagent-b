# P0 Production Foundation

## Mission
MyGymAgent is a complete AI-driven multi-tenant Gym Operating System. PT is one subsystem, not the product identity.

## P0 acceptance gates
- Tenant isolation is enforced at authentication, authorization, service/query, jobs/events, storage, reporting and AI-tool boundaries.
- No client-supplied organization/branch identifier can override server-derived scope.
- Production secrets are supplied through environment configuration, never committed.
- Production cookies/CORS are configured for the actual frontend/API origins.
- Database changes use committed Prisma migrations only; no manual production schema edits.
- Production startup applies pending migrations safely and fails closed on migration errors.
- `/health` is liveness; `/ready` is dependency readiness.
- Redis is not exposed publicly.
- PostgreSQL is not exposed publicly when using managed Postgres.
- AI has minimum-privilege, tenant-scoped tools and cannot directly execute arbitrary database operations.
- Error responses do not expose stack traces, secrets, SQL, tokens or cross-tenant data.
- Rate limiting, validation, security headers and authentication protections remain enabled in production.
- VPS deployment must not modify or disrupt existing MyPTStudio services.

## Current deployment target
- Frontend: Next.js container, internal port 3000.
- Backend: NestJS container, internal port 4000.
- Reverse proxy: Nginx on VPS, to be configured only after a domain exists.
- Database: PostgreSQL, preferably managed for production.
- Queue: Redis, private network only.
- Object storage: S3-compatible/R2.
- AI: OpenRouter through controlled backend services.

## Explicit non-goals for P0
- Do not build flashy AI features before the security/data foundation is verified.
- Do not rewrite the modular monolith into microservices.
- Do not introduce destructive migrations without a staged migration plan.
- Do not use the local-development Docker Compose file as the production deployment contract without hardening it.

## Verification
A P0 milestone is not complete until appropriate build/typecheck/tests, migration checks, security checks, tenant-isolation checks and deployment health checks have been executed and results recorded.
