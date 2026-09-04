# Workout Sessions — workout execution layer

The missing execution layer on top of the workouts module's
`WorkoutPlan` / `WorkoutAssignment` shape: **one `WorkoutSession` row per
time a member actually runs an assigned workout**, with sets logged as they
happen.

## Why this exists

`docs/ARCHITECTURE.md` (workouts v1 scope) deliberately deferred execution:
a trainer could build a plan and assign it, but nothing recorded whether the
member actually did the workout. This module closes that gap the way the
frontend already expected (`/workout-sessions` routes in `mygymagent-f`,
"Today's Sessions" page) — start an active assignment, log sets per
exercise, complete the session.

## Endpoints

| Method | Route | Permission | Notes |
|---|---|---|---|
| GET | `/workout-sessions/today` | `workouts.read` \| `workouts.read_assigned` | Today's sessions; trainer-scoped via `CurrentAssignmentScope` |
| GET | `/workout-sessions/:id` | `workouts.read` \| `workouts.read_assigned` | Full session: exercise snapshot + logged sets |
| POST | `/workout-sessions/assignment/:assignmentId/start` | `workouts.assign` | Snapshots the plan's exercises into the session |
| POST | `/workout-sessions/:sessionId/exercises/:sessionExerciseId/sets` | `workouts.assign` | Idempotent per `(session, exercise, setNumber)` via upsert |
| PATCH | `/workout-sessions/:sessionId/complete` | `workouts.assign` | Marks COMPLETED + emits `workout.session_completed` |

## Conventions

- **Tenant isolation**: every query scoped by `organizationId` from the
  verified JWT; `read_assigned` callers additionally scoped to
  `member.assignedTrainerId === caller id` (same `CurrentAssignmentScope`
  pattern as workout-assignments).
- **History immutability**: the plan's exercises are snapshotted into
  `WorkoutSession.exercises` (JSON) at start time — later plan edits never
  rewrite execution history. Sets are upserted by
  `(sessionId, exerciseId, setNumber)` so retries don't create duplicates
  (`@@unique` in the schema backs this).
- **Events**: `workout.session_started` and `workout.session_completed`
  are emitted on the domain bus (no consumers yet — same as most events in
  the catalog).
- **Audit**: all three mutating routes carry `@Audited`.

## Not built

- Per-exercise timer/rest tracking (sets only), session duration metrics
  derived from startedAt/completedAt are trivial for a future analytics
  module, but nothing computes them today.
- Automatically flipping the assignment to COMPLETED when a session
  completes — the frontend does that explicitly via
  `PATCH /workout-assignments/:id/status`, and keeping the two statuses
  independent preserves history (a member can complete a session but stay
  on an active plan).