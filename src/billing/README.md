# billing

**Status: not implemented in this phase.** Empty NestJS module only, registered in `AppModule` to reserve the seam.

Payments, invoices, refunds, discounts, taxes, trainer payouts/commissions. See docs/ARCHITECTURE.md#billing-architecture. Ledger-style: financial records are never mutated in place, only appended and superseded, the same immutable-history pattern used by Membership.previousMembershipId.

When this module is built, it will follow the same conventions as the implemented core modules (organizations, branches, users, members, membership-plans, memberships, attendance):
- Every query/mutation scoped by `organizationId` taken from `@CurrentUser()`, never from client input.
- Routes protected by `@RequirePermissions('billing.<action>')` against the permission catalog in `src/rbac/permissions.catalog.ts` (already seeded).
- Mutating endpoints annotated `@Audited(...)` for the audit trail.
- Cross-module effects via the domain event bus (`src/events/domain-events.ts`) rather than direct service-to-service coupling.
