# crm

**Status: not implemented in this phase.** Empty NestJS module only, registered in `AppModule` to reserve the seam.

Lead pipeline (New -> Contacted -> Qualified -> Trial -> Won/Lost), follow-ups, campaigns, referrals. See docs/ARCHITECTURE.md#leads-crm.

When this module is built, it will follow the same conventions as the implemented core modules (organizations, branches, users, members, membership-plans, memberships, attendance):
- Every query/mutation scoped by `organizationId` taken from `@CurrentUser()`, never from client input.
- Routes protected by `@RequirePermissions('crm.<action>')` against the permission catalog in `src/rbac/permissions.catalog.ts` (already seeded).
- Mutating endpoints annotated `@Audited(...)` for the audit trail.
- Cross-module effects via the domain event bus (`src/events/domain-events.ts`) rather than direct service-to-service coupling.
