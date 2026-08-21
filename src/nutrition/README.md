# nutrition

**Status: partially implemented (v1 scope).** Food library, diet plans,
and plan assignment are real, mirroring the Workouts module's shape
exactly (a `DietPlan` is to `WorkoutPlan` what a `FoodItem` is to
`Exercise`). Versioned plan history and a food database beyond an org's
own custom entries (also mentioned in the original description) are
deferred -- see "What's still missing".

## What exists

- `GET/POST /food-items` (`nutrition.read`/`nutrition.create`) -- an org's
  custom food/ingredient library (name, serving size, calories, macros).
  No shared global food database in v1 -- same reasoning as `Exercise`.
- `GET/POST /diet-plans`, `GET/PATCH /diet-plans/:id`
  (`nutrition.read`/`nutrition.create`) -- a named, reusable plan: an
  items list (`{foodItemId, mealSlot, quantity, unit, notes}`) stored as
  JSON (not a join table, same reasoning as `WorkoutPlan.exercises`),
  plus optional daily macro targets on the plan itself. Every referenced
  `foodItemId` is verified to belong to the caller's organization before
  a plan is created or updated.
- `POST /diet-plans/:id/assign` (`nutrition.assign`) -- assigns a plan to
  a member. A plan is a reusable template; the same plan can be assigned
  to many members, each with its own status.
- `GET /diet-assignments`, `PATCH /diet-assignments/:id/status`
  (`nutrition.read`/`nutrition.assign`) -- a member's assigned plans and
  their lifecycle (`ACTIVE` -> `COMPLETED`/`CANCELLED`).

Every query/mutation is scoped by `organizationId` taken from
`@CurrentUser()`, same as every other implemented module.

## What's still missing

- No versioned plan history -- editing a plan overwrites its `items`,
  it doesn't keep prior versions. Worth adding once plans are actually
  being iterated on in practice.
- No shared/public food database (USDA-style lookup) -- every org starts
  its food library from empty.

AI-assisted plan generation (`create_diet_draft`) is built -- see
`src/ai/README.md`.
