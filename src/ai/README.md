# ai

**Status: not implemented in this phase.** Empty NestJS module only, registered in `AppModule` to reserve the seam.

AI Gateway -> Model Router -> Provider Adapters -> Specialized Agents -> Domain Tools -> Structured Output Validation -> Persistence/Audit. See docs/ARCHITECTURE.md#ai-architecture. AI never queries the database directly; it calls permission-aware tools (get_member_profile, create_workout_draft, ...) that enforce the same PermissionsGuard checks as the REST API. Consequential AI output is always a draft requiring human approval before it is committed (see AI Safety).

When this module is built, it will follow the same conventions as the implemented core modules (organizations, branches, users, members, membership-plans, memberships, attendance):
- Every query/mutation scoped by `organizationId` taken from `@CurrentUser()`, never from client input.
- Routes protected by `@RequirePermissions('ai.<action>')` against the permission catalog in `src/rbac/permissions.catalog.ts` (already seeded).
- Mutating endpoints annotated `@Audited(...)` for the audit trail.
- Cross-module effects via the domain event bus (`src/events/domain-events.ts`) rather than direct service-to-service coupling.
