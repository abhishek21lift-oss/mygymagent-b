# Platform billing vs. gym operational billing (design only — not implemented)

## The distinction, stated plainly

**Platform billing**: the gym (organization) pays *us* (the SaaS platform) a subscription fee for
using MyGymAgent.

**Gym operational billing**: a gym's *members* pay *the gym* for their membership, personal
training, products, etc.

These are financially, legally, and operationally unrelated. A bug that conflates them is a
category error, not just a modeling inconvenience — e.g. it must never be possible for a
platform-billing failure (the gym's card on file with us expires) to be recorded in the same table
as a member's failed membership payment, and a report answering "how much revenue did this gym make
this month" must never accidentally include what that gym paid *us*.

## Two separate model families

### Platform billing (us ← gym)
```prisma
model PlatformSubscription {
  id             String   @id @default(uuid())
  organizationId String   @unique
  organization   Organization @relation(fields: [organizationId], references: [id])
  // links to OrganizationSubscription (plans-and-limits.md) for what plan/limits apply
  stripeCustomerId     String?   // or whichever payment processor
  stripeSubscriptionId String?
}

model PlatformInvoice {
  id             String   @id @default(uuid())
  organizationId String
  amount         Decimal  @db.Decimal(10, 2)
  currency       String
  status         String   // draft | open | paid | void | uncollectible
  periodStart    DateTime
  periodEnd      DateTime
  paidAt         DateTime?
}
```
Owned by: the platform. Visible to: the organization's owner/admin (their own invoices only) and
platform admins (all organizations' invoices) via the `/platform/*` surface
(`src/platform/`, see `docs/security/overview.md`) — the same deliberately-separate,
explicitly-guarded pattern already used for cross-tenant organization administration, per ADR
0001's trade-offs section.

### Gym operational billing (member ← gym)
```prisma
model Payment {
  id             String   @id @default(uuid())
  organizationId String
  branchId       String
  memberId       String
  membershipId   String?  // nullable: could be a one-off product/PT sale, not tied to a membership
  amount         Decimal  @db.Decimal(10, 2)
  currency       String
  method         String   // cash | card | upi | bank_transfer | ...
  status         String   // pending | completed | refunded | failed
  createdAt      DateTime @default(now())
}

model Refund {
  id         String   @id @default(uuid())
  paymentId  String
  amount     Decimal  @db.Decimal(10, 2)
  reason     String?
  createdAt  DateTime @default(now())
}
```
Owned by: the organization. Visible to: org/branch staff with `payments.*` permissions (already in
the permission catalog — `ACCOUNTANT`/`SALES_EXECUTIVE`/`BRANCH_MANAGER` roles already list
`payments.read`/`payments.create`/`payments.refund` even though the table doesn't exist yet, per
`ROLES_CATALOG`'s own comment about granting forward-looking permissions). Follows the same
immutability rule as `Membership`: a refund is a new linked row, never a mutation/deletion of the
original `Payment`.

## Why not one `Transaction` table with a `type` discriminator
Considered and rejected. A shared table invites exactly the query-time mistake this separation
exists to prevent — one missed `WHERE type = 'gym'` filter in a report query and platform revenue
leaks into a gym's P&L, or vice versa. Two tables with two independently-scoped access-control paths
make that class of bug structurally harder to write, the same reasoning ADR 0001 applies to tenant
isolation itself.

## What exists today
The **gym operational billing** side: `Payment` and `Refund` (`src/billing/payments.controller.ts`,
`payments.service.ts`) — real, org/branch-scoped records of a member paying the gym, following the
immutability rule above (a refund is a new linked row, never a mutation of the original `Payment`).
`Payment.membershipId` is nullable exactly as this doc anticipated, for one-off product/PT sales not
tied to a membership.

**Platform billing** (`PlatformSubscription`, `PlatformInvoice`) is still design-only — nothing
charges an organization for using MyGymAgent yet. This is the one gap this doc's own separation
argument was written to protect: build it as its own model family when prioritized, never by adding
a `type` column to `Payment`.
