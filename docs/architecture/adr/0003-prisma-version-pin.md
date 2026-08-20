# ADR 0003: Pin Prisma to v6 (`prisma-client-js` generator), not v7

## Status
Accepted, implemented. Revisit when Prisma 7's Node/CJS runtime story stabilizes.

## Context
Prisma 7 ships a new `prisma-client` generator as the default. Its generated output mixes
`import.meta.url` (ESM-only syntax) with literal `exports.X = ...` CommonJS assignments in the same
file, which throws `ReferenceError: exports is not defined in ES module scope` under plain
Node/CommonJS execution (`ts-node`, `tsx`, and compiled CJS output all hit this).

## Options considered
1. **Prisma 7 + `prisma-client` generator, ESM throughout** — would require converting the entire
   NestJS app (and its Jest test config) to ESM, a large, risky, unrelated migration just to use a
   dependency's newest major version.
2. **Prisma 7 + `@prisma/adapter-pg` driver adapter** — sidesteps some of the generator issues but
   is a materially different runtime path (driver adapters vs. the built-in query engine) with its
   own migration surface.
3. **Prisma 6, classic `prisma-client-js` generator.**

## Decision
Option 3: `prisma@6` / `@prisma/client@6` with `generator client { provider = "prisma-client-js" }`.
Boring, stable, works with plain CommonJS Node — which is what NestJS assumes by default. The CI
build shows an "update available" notice on every `prisma generate`; that's expected and ignored
until the ESM/CJS story for v7 is resolved upstream, not evidence of an oversight.

## Trade-offs
- Missing whatever Prisma 7-only features/perf improvements ship in the new generator until we
  revisit this.
- One more version-pin to track and eventually unpin.

## Consequences
`prisma/seed.ts` runs via `tsx` (not `ts-node`) for the same underlying reason — even after pinning
the generator, some dev tooling in the Prisma 7 era assumes ESM-friendly loaders.
