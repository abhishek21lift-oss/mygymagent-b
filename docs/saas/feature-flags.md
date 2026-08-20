# Feature flags (design only — not implemented)

## Purpose
Let features (AI, PT, Inventory, Nutrition, Advanced Analytics, WhatsApp, Payroll, Multi-branch) be
enabled per organization, independent of code deploys — a flag decides *availability*, a subscription
plan decides *what a plan includes by default* (see `plans-and-limits.md` for how the two relate).

## Proposed model

```prisma
model FeatureFlag {
  id             String   @id @default(uuid())
  key            String   @unique   // "ai", "pt", "inventory", "whatsapp", ...
  name           String
  description    String?
  defaultEnabled Boolean  @default(false)  // fallback if no org-level override exists
}

model OrganizationFeature {
  id             String       @id @default(uuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  featureKey     String
  feature        FeatureFlag  @relation(fields: [featureKey], references: [key])
  enabled        Boolean

  @@unique([organizationId, featureKey])
}
```

- Resolution order: `OrganizationFeature` row for this org+key if present, else `FeatureFlag.defaultEnabled`.
- A `FeaturesService.isEnabled(organizationId, key)` call, cached per-request (via `nestjs-cls`,
  already a dependency, used elsewhere for request-scoped context), not re-queried per check within
  one request.

## Enforcement points
- **Backend**: a `@RequireFeature('ai')` decorator + guard, same shape as the existing
  `@RequirePermission()` — checked in addition to, not instead of, RBAC. A user can have the
  `ai.generate` permission and still get a 403 if their org's plan/flag doesn't include AI.
- **Frontend**: `nav-config.ts` (already permission-aware) extends to also filter by feature flags,
  so a disabled feature's nav item doesn't appear rather than appearing and 403ing on click.

## Relationship to SaaS plans
A subscription plan (see `plans-and-limits.md`) sets the *default* `OrganizationFeature` rows when
an org subscribes/upgrades — e.g. moving to "Business" tier auto-enables `inventory` and
`advanced_analytics`. An org can still have individual flags overridden beyond their plan (e.g. a
platform admin manually granting early access to a feature for one customer) — that's exactly why
`OrganizationFeature` is a separate table from plan tier, not a computed property of it.

## Not building yet, on purpose
A general-purpose flag *targeting* system (percentage rollouts, user-level flags, A/B experiment
flags) is out of scope — this is a per-organization product-tier gate, not an experimentation
platform. If experimentation is needed later, it's a different, additive system, not a
generalization of this one.
