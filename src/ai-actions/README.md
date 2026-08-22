# ai-actions

**Status: implemented (P3 scope).** The Action Center: READ -> RECOMMEND -> DRAFT -> APPROVE ->
EXECUTE for AI-proposed changes the master prompt calls "high-risk" -- the ones P0-P2's AI tools
deliberately avoided needing (see `src/ai/README.md`'s "No approval queue" note, now superseded by
this module).

## What exists

- **Two propose-only AI tools** (`propose_assign_workout_plan`, `propose_assign_diet_plan` in
  `src/ai/tools/tool-definitions.ts`) -- the model can never assign a plan directly; it can only
  create a `PENDING_APPROVAL` `AiAction` row via `AiActionsService.proposeAssignPlan()`, gated on
  the same `resolveAccess()` pattern (`workouts.assign`/`nutrition.assign`) every other tool uses,
  so a caller who couldn't assign a plan over REST can't get the AI to propose one either.
- **`GET /ai-actions`, `GET /ai-actions/:id`, `PATCH /ai-actions/:id/approve`,
  `PATCH /ai-actions/:id/reject`** (`ai-actions.controller.ts`), all gated on `ai.approve`.
- **Two-permission approval**: `ai.approve` alone only proves "this user is allowed to decide on
  AI proposals" -- it is deliberately not conflated with "this user may perform whatever the AI
  proposed." `AiActionsService.approve()` independently re-checks the *approver* holds the
  REST-equivalent resource permission (`REQUIRED_PERMISSION` map: `ASSIGN_WORKOUT_PLAN` ->
  `workouts.assign`, `ASSIGN_DIET_PLAN` -> `nutrition.assign`) via
  `PermissionsService.hasPermission()` before executing anything. This is the direct extension of
  the master prompt's "AI must never bypass existing permissions" rule to the approval step
  itself, not just the propose step.
- **Re-validation at execution time, not just at proposal time**: `execute()` re-runs the stored
  `payload` through `validateToolArgs(AssignPlanPayloadDto, ...)` before calling
  `WorkoutPlansService.assign()`/`DietPlansService.assign()` -- a payload that was well-formed when
  proposed is still re-checked now, the same "never trust stored JSON blindly" discipline applied
  to model-supplied input elsewhere in `src/ai/`.
- **The approver is recorded as the actor**, not the proposer -- `decidedByUserId` is passed as the
  assigning user to `WorkoutPlansService.assign()`/`DietPlansService.assign()`. The AI only drafted
  a suggestion; the human who approved it is the one who actually performed the action, for audit
  purposes and consistent with every other assignment in the system always having a real human
  actor.
- **Full status lifecycle**: `PENDING_APPROVAL` -> `APPROVED` -> `EXECUTED` (or `FAILED`, with
  `errorMessage` recorded, if `execute()` throws -- e.g. the member or plan was deleted between
  proposal and approval) -- or `PENDING_APPROVAL` -> `REJECTED` (with an optional `rejectionReason`).
  A decided action cannot be re-approved or re-rejected (`getOne()` + status check).
- **Existence checked at proposal time**: `proposeAssignPlan()` confirms the member and plan are
  real (and belong to this org) before creating a proposal about them -- a proposal for a
  nonexistent member helps no approver.
- **Audited**: `PATCH :id/approve` and `PATCH :id/reject` both carry `@Audited(...)`, in addition
  to the underlying `WorkoutPlansService.assign()`/`DietPlansService.assign()` call's own audit
  entry when an approval executes successfully.

## Why only plan assignment, not every write tool

P0-P2's other write tools (`create_workout_draft`, `create_diet_draft`, `create_followup`) don't
need this flow -- they were deliberately designed to be safe without one (see `src/ai/README.md`):
a draft plan is inert until a human assigns it, and a follow-up is a task for a human to act on, not
an autonomous change. Plan *assignment* is the first genuinely consequential action an AI tool can
trigger (it changes what a member is actually prescribed), which is exactly why it's the one routed
through this approval flow instead of being a ninth direct-write tool.

## What's still out of scope

- No proposal type beyond the two plan-assignment ones exists yet. Any future AI capability that
  performs a consequential action (converting a lead, charging a payment, canceling a membership)
  needs its own `AiActionType`, its own entry in `REQUIRED_PERMISSION`, and its own `execute()`
  case -- not a bypass of this flow.
- No notification when a proposal is created (an approver has to check `GET /ai-actions` to find
  pending ones) -- this module doesn't own notifications; wiring one in is a P1-Communication-style
  follow-up if usage shows approvers aren't checking proactively.
- No auto-expiry of long-pending proposals. A `PENDING_APPROVAL` action sits indefinitely until a
  human acts on it.
