# workouts

**Status: not implemented in this phase.** Empty NestJS module only, registered in `AppModule` to reserve the seam.

Exercise library, Program -> Phase -> Week -> Day -> Workout -> Exercise -> Set hierarchy, and historical workout logs. See docs/ARCHITECTURE.md#workout-engine. Assignment creates a WorkoutAssigned domain event for the future Notifications module.

When this module is built, it will follow the same conventions as the implemented core modules (organizations, branches, users, members, membership-plans, memberships, attendance):
- Every query/mutation scoped by `organizationId` taken from `@CurrentUser()`, never from client input.
- Routes protected by `@RequirePermissions('workouts.<action>')` against the permission catalog in `src/rbac/permissions.catalog.ts` (already seeded).
- Mutating endpoints annotated `@Audited(...)` for the audit trail.
- Cross-module effects via the domain event bus (`src/events/domain-events.ts`) rather than direct service-to-service coupling.
