# ADR 0005: Two separate repos (frontend/backend), not a monorepo

## Status
Accepted, implemented — deviates from the original prompt's suggested monorepo layout.

## Context
The originating spec suggested a monorepo (`apps/web`, `apps/api`, `packages/ui`, `packages/types`,
...). The actual project was created as two independent GitHub repositories,
`mygymagent-f` (Next.js) and `mygymagent-b` (NestJS), each on its own deploy target.

## Options considered
1. **Monorepo** with shared `packages/types`, `packages/validation` etc. for compile-time-shared
   contracts between frontend and backend.
2. **Two repos**, contract sharing done by convention (hand-written TypeScript types on the
   frontend that mirror the backend's DTOs/response shapes) rather than a shared package.

## Decision
Two repos (already the case at the time this was written, given as GitHub repos already
provisioned). Each deploys independently — frontend to Vercel, backend to Render — with no shared
build step or workspace tooling between them.

## Trade-offs
- **Lost:** compile-time-enforced API contracts. Today, `src/lib/types/*.ts` on the frontend and the
  backend's DTOs/entities are two independently maintained sources of truth — see
  `docs/api/conventions.md`'s "keeping frontend and backend in sync" section for the discipline this
  requires (grep-verify on every backend response-shape change) until this is automated.
- **Gained:** independent deploy cadence, independent CI, no cross-repo build coordination, simpler
  onboarding for a contributor who only touches one side.

## When to revisit
If/when a generated OpenAPI spec + client codegen step is introduced (see
`docs/api/conventions.md`), the "two independently maintained type sets" trade-off goes away without
needing to merge the repos — codegen against the deployed/published OpenAPI JSON works across a repo
boundary just as well as within a monorepo. Revisit the monorepo question only if repo-crossing
tooling (shared lint config, shared UI kit) becomes painful enough to justify the migration cost.
