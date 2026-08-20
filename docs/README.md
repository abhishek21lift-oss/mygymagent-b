# Documentation index

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the full technical blueprint: system architecture, domain
  map, multi-tenant model, RBAC, deferred-domain list.
- **[architecture/adr/](./architecture/adr/)** — Architecture Decision Records for choices made along
  the way and why.
- **[database/](./database/)** — ERD, per-entity data-ownership matrix, retention policy.
- **[api/conventions.md](./api/conventions.md)** — REST conventions, error envelope, pagination,
  versioning.
- **[security/overview.md](./security/overview.md)** — authn/authz model, tenant isolation, the
  security test matrix and what's actually covered today.
- **[deployment/overview.md](./deployment/overview.md)** — dev/staging/production, Docker, CI/CD,
  migrations, rollback, backups.
- **[testing/strategy.md](./testing/strategy.md)** — unit/integration/e2e/security coverage, what
  exists vs. what's aspirational.
- **[ai/architecture.md](./ai/architecture.md)** — AI gateway/tooling/guardrails design for the
  not-yet-built `ai` module. Design only — no code yet.
- **[saas/](./saas/)** — feature flags, subscription plans, platform-vs-gym billing separation.
  Design only — no code yet.
- **[integrations/overview.md](./integrations/overview.md)** — adapter pattern for external
  integrations. Design only — no code yet.
- **[import-export.md](./import-export.md)** — CSV import/export architecture. Design only — no code
  yet.

Docs marked "design only" describe domains that are still module skeletons in `src/` (see
`ARCHITECTURE.md`'s deferred-domain list) — this was a deliberate scope decision: build the
multi-tenancy/auth/RBAC/audit/core-gym-domain foundation to production quality first, and document
everything else before building it, rather than half-building many domains at once.
