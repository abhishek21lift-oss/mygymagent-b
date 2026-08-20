# SaaS subscription plans + configurable limits (design only — not implemented)

## Tiers (conceptual, not hard-coded)

`Free/Trial`, `Starter`, `Professional`, `Business`, `Enterprise` — names and their limits/features
live in data, not in application code, so a limit can change (or a new tier can be added) without a
deploy.

## Proposed model

```prisma
model SubscriptionPlan {
  id          String   @id @default(uuid())
  key         String   @unique   // "starter", "professional", ...
  name        String
  // Price is NOT modeled here as a fixed column — see billing-separation.md.
  // This table owns *limits and included features*, billing owns *what it costs*.

  maxMembers        Int?   // null = unlimited
  maxBranches       Int?
  maxStaff          Int?
  aiMonthlyRequests Int?
  storageMb         Int?
  whatsappMonthly   Int?
  apiMonthlyCalls   Int?

  includedFeatures  OrganizationFeature[]  // default feature-flag set for this tier, see feature-flags.md
}

model OrganizationSubscription {
  id             String           @id @default(uuid())
  organizationId String           @unique
  organization   Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  planId         String
  plan           SubscriptionPlan @relation(fields: [planId], references: [id])
  status         String           // trialing | active | past_due | cancelled
  currentPeriodEnd DateTime
  // Links to platform billing (see billing-separation.md) via a separate PlatformInvoice table,
  // not embedded here — this table is "what plan and limits apply right now," not "billing history."
}
```

## Server-side enforcement (the part that actually matters)

Limits are checked at the point of creation, in the domain service, not just displayed in the UI:

```
MembersService.create(...)
  → LimitsService.assertUnder(organizationId, 'maxMembers')
  → throws 402/403 with a clear "upgrade required" error code if at/over limit
  → otherwise proceeds
```

A `LimitsService.currentUsage(organizationId, resource)` computes current counts (member count,
branch count, this-month's AI request count, etc.) — for count-based limits this is a straightforward
`count()` query; for rate-based limits (AI requests this month, WhatsApp messages this month) it
reads from the same per-tenant usage tracking that `docs/ai/architecture.md`'s cost-control section
already calls for, so AI usage tracking isn't built twice for two different reasons.

**UI-only limit enforcement (e.g. graying out an "Add Member" button past 500 members) is not
suficient on its own** — it's a UX nicety layered on top of the server-side check, never a
replacement for it. A direct API call must be rejected server-side regardless of what the UI shows.

## Why prices aren't in this table
See `billing-separation.md` — what a plan *includes* (this file) and what it *costs* (platform
billing) are modeled separately so pricing experiments (regional pricing, discounts, grandfathered
legacy pricing) don't require touching the limits/features model at all.
