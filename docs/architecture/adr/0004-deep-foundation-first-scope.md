# ADR 0004: Build the foundation to production quality first; defer breadth

## Status
Accepted, in effect.

## Context
The full product vision spans ~30 domains (workouts, nutrition, AI, billing, inventory, CRM,
notifications, analytics, integrations, ...). Building all of them at once, at low depth, produces
a platform where nothing is actually trustworthy: half-built auth, half-built tenant isolation,
half-built everything.

## Decision
Two tiers, chosen explicitly (via user confirmation) over building breadth-first:

1. **Deep foundation (production quality, fully tested):** multi-tenancy, authentication,
   authorization/RBAC, audit logging, and the core gym domain (organizations, branches, users,
   members, membership plans, memberships, attendance).
2. **Deferred domains (architecture doc + module skeleton only, no business logic):** `ai`,
   `billing`, `workouts`, `nutrition`, `inventory`, `crm`, `notifications`, `files`, `search`,
   `analytics`. Each has a `README.md` in its module directory describing its intended
   responsibilities and data model, and a `Module` class registered in `AppModule` so routing/DI
   wiring is in place, but no controllers/services/business logic.

Later additions (feature flags, SaaS plan/limit enforcement, platform-vs-gym billing separation, AI
tool-calling architecture, import/export, integrations abstraction) followed the same rule: design
doc first (see `docs/saas/`, `docs/ai/`, `docs/integrations/`, `docs/import-export.md`), code only
once explicitly requested for a specific domain.

## Trade-offs
- The product isn't feature-complete — most of the spec's product surface doesn't exist as code
  yet.
- What does exist is real: production-grade tenant isolation, RBAC with per-user overrides, audit
  logging, a tested auth flow — not stubs that would need to be rewritten to become real.

## Consequences
When a deferred domain is picked up, read its module `README.md` first — it documents assumptions
already made about the domain's shape so implementation doesn't contradict earlier design intent.
