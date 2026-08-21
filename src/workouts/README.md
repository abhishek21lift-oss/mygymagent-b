# workouts

**Status: partially implemented (v1 scope).** Exercise library, workout
plans, and plan assignment are real. The originally-described
`Program -> Phase -> Week -> Day -> Workout -> Exercise -> Set` hierarchy
was deliberately scoped down for a first implementation -- that's
periodization-app depth, and building all seven levels before anyone had
used a single one would be over-engineering. See `docs/architecture/adr/`
for the same reasoning applied elsewhere (Prisma version, react-table
version, deep-foundation-first scope).

## What exists

- `GET/POST /exercises` (`workouts.read`/`workouts.create`) -- an org's
  custom exercise library. No shared global catalog in v1: gyms organize
  exercises differently enough that a shared catalog would need a "my
  gym's variant of this" escape hatch anyway.
- `GET/POST /workout-plans`, `GET/PATCH /workout-plans/:id`
  (`workouts.read`/`workouts.create`) -- a named, reusable program: an
  ordered list of `{exerciseId, sets, reps, restSeconds, notes}`, stored as
  JSON on the plan (not a join table -- a plan's exercise list is always
  read/written as one unit, never queried per-exercise-row; see the
  schema comment on `WorkoutPlan.exercises`). Every referenced
  `exerciseId` is verified to belong to the caller's organization before
  a plan is created or updated.
- `POST /workout-plans/:id/assign` (`workouts.assign`) -- assigns a plan
  to a member. A plan is a reusable template; the same plan can be
  assigned to many members, each with its own status.
- `GET /workout-assignments`, `PATCH /workout-assignments/:id/status`
  (`workouts.read`/`workouts.assign`) -- a member's assigned plans and
  their lifecycle (`ACTIVE` -> `COMPLETED`/`CANCELLED`).

Every query/mutation is scoped by `organizationId` taken from
`@CurrentUser()`, same as every other implemented module.

## What's still missing

- No per-set logging (actual weight/reps performed) -- assignments track
  status only, not workout history. That's the natural next layer once
  the plan/assignment shape has been used for real.
- No periodization (phases/weeks/progressive overload scheduling).
- No AI-assisted plan generation -- see `docs/ai/architecture.md`'s
  `create_workout_draft` tool, which will call into `WorkoutPlansService`
  the same way the REST API does, once the `ai` module exists.
