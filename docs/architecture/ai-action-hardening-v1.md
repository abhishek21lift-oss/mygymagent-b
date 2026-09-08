# AI Action Hardening v1

This document records the production-hardening contract for consequential AI actions.

## Current model

AI follows:

`READ -> RECOMMEND -> DRAFT -> APPROVE -> EXECUTE`

The approval layer currently covers workout-plan and diet-plan assignment only. The approver must hold both `ai.approve` and the underlying REST-equivalent permission.

## Mandatory invariants

1. The organization and user are always taken from the authenticated request, never from model arguments.
2. Stored action payloads are revalidated immediately before execution.
3. The approver is the actor recorded for the underlying domain mutation.
4. A non-pending action cannot be approved or rejected again.
5. Domain permissions remain authoritative; `ai.approve` never substitutes for `workouts.assign`, `nutrition.assign`, or future resource permissions.
6. Future consequential actions must be added as explicit action types with an explicit required-permission mapping.

## Known next hardening items

- Make approval execution idempotent under concurrent approvals.
- Add explicit action expiry to prevent indefinite pending actions.
- Notify eligible approvers when a consequential proposal is created.
- Add prompt-injection regression tests around tool-result content.
- Add AI usage budget enforcement from recorded `AiUsageLog` data.
- Add end-to-end tests proving branch/assignment scope is preserved for every AI tool.

## Safety boundary

AI may draft and recommend freely within its typed tools. Any future tool that charges money, cancels membership, converts a lead, modifies attendance, or otherwise changes a consequential business record must use the Action Center rather than direct execution.
