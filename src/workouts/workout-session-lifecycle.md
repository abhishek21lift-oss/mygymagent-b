# PT Workout Session Lifecycle

The workout assignment is the long-lived plan relationship. A `workout_session` is the daily execution record.

## Lifecycle

`SCHEDULED -> IN_PROGRESS -> COMPLETED`

Exceptional terminal states:

- `SCHEDULED -> CANCELLED`
- `IN_PROGRESS -> SKIPPED`
- `IN_PROGRESS -> NO_SHOW`
- `IN_PROGRESS -> CANCELLED`

Terminal states cannot be reopened through the current API.

## Endpoints

- `GET /workout-assignments/today-sessions`
- `POST /workout-assignments/:id/session/start`
- `PATCH /workout-assignments/:id/session`

All endpoints are organization-scoped and require the existing workout permissions. Mutations are automatically audited.

## Idempotency

Starting a session for the same assignment and session date uses the database unique constraint `(assignmentId, sessionDate)`. Repeated starts reuse the existing daily record instead of creating duplicates.

## Next layer

Exercise/set-level execution should be modeled separately from the daily session. It should capture prescribed vs completed sets, actual load/reps/RPE, trainer notes, and member feedback without changing the assignment itself.
