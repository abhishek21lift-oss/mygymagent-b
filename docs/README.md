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
  `ai` module (built: v1 tool-calling agent + conversations — see `src/ai/`).
- **[saas/](./saas/)** — feature flags, subscription plans, platform-vs-gym billing separation
  (built: `src/platform/` + `src/billing/` — see `docs/saas/billing-separation.md`).
- **[integrations/overview.md](./integrations/overview.md)** — adapter pattern for external
  integrations (built: `src/whatsapp/`, `src/communications/`; email provider-backed).
- **[import-export.md](./import-export.md)** — CSV import/export architecture. Design only — no code
  yet.

Some older docs still carry "design only" / deferred-domain notes from the
deep-foundation phase — where a doc conflicts with shipped code under `src/`
(see `ARCHITECTURE.md`'s built-domain list), the code is authoritative.
