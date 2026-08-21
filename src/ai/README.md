# ai

**Status: partially implemented (v1 scope).** A single tool-calling chat
endpoint is real. The full Gateway -> Model Router -> Provider Adapters ->
Specialized Agents pipeline described in `docs/ai/architecture.md` is
scoped down to its essentials for a first pass: one provider (OpenRouter),
no model routing (one configured model for everything), no persisted
conversation memory.

## What exists

- `POST /ai/chat` (`ai.generate`) -- takes `{ message, history? }`
  (`history` is the client-resent prior turns; no server-side conversation
  storage in v1 -- see "What's still missing"), runs a bounded tool-calling
  loop (max 6 iterations) against OpenRouter, and returns
  `{ reply, toolCalls }` (`toolCalls` is included for transparency/
  debugging in the UI, not just an internal detail).
- **Explicit tool allowlist** (`tools/tool-definitions.ts`), exactly the
  set `docs/ai/architecture.md` specified: `read_member`,
  `read_workout_history`, `read_attendance`, `create_workout_draft`,
  `create_diet_draft`, `create_followup`. No `execute_sql`-shaped tool
  exists or ever should -- see `docs/ai/architecture.md`'s "§56" section.
- **No special-cased data path**: every tool executor
  (`tools/tool-executor.service.ts`) calls the exact same
  organizationId-scoped domain service the REST API uses
  (`MembersService`, `AttendanceService`, `WorkoutPlansService`,
  `WorkoutAssignmentsService`, `DietPlansService`, `LeadsService`).
  `organizationId` comes from the authenticated caller's JWT
  (`AiController` -> `AiService`), never from anything the model said.
- **Structured validation before persistence**: every tool's arguments are
  validated against a DTO (`tools/validate-tool-args.ts`, the same
  class-validator machinery the global `ValidationPipe` uses) before
  touching a domain service -- raw model JSON never reaches a Prisma call
  directly.
- **Read tools return summaries, not raw rows** -- `read_member` omits PII
  (email/phone/address), `read_attendance` returns a 30-day count + 5 most
  recent dates rather than a full log. See
  `docs/database/data-ownership.md`'s AI-access column.
- **Mutating tool calls are explicitly audited** (`AuditService.record()`
  inside the executor, not just the one `@Audited()` on `/ai/chat` --
  that decorator only wraps the single HTTP call, not the individual
  service calls made during tool execution).
- **Guardrails**: a per-request timeout (30s) and output-token cap (2000)
  on the provider call, and a bounded tool-call loop -- see
  `providers/openrouter.provider.ts` and `ai.service.ts`.

## Deliberate v1 simplifications (read before extending this module)

- **No approval queue.** The original design said "consequential AI
  output is always a draft requiring human approval before commit" (the
  `ai.approve` permission in the catalog is reserved for this, unused
  today). v1's two write tools are safe without one *by construction*,
  not because the rule was dropped: `create_workout_draft` and
  `create_diet_draft` create an **unassigned** plan -- inert until a
  human explicitly assigns it (`POST /workout-plans/:id/assign` or
  `POST /diet-plans/:id/assign`, neither of which is an AI tool); and
  `create_followup` creates a task for a *human* to act on (call/email a
  lead), not an autonomous action on the lead itself. If a future tool
  does something directly consequential (assigns a plan, converts a lead,
  charges a payment), it needs a real `PENDING`-status + approve/reject
  flow using `ai.approve`, not immediate execution like these two.
- **No conversation persistence.** The client resends history each
  request. Building this properly means a `Conversation`/`Message` table
  with the same retention rules already documented in
  `docs/database/data-retention.md`'s AI-conversations section -- not
  attempted here to keep this pass proportionate to the other v1 modules.
- **No model routing.** One `OPENROUTER_MODEL` for every request. Routing
  cheap-vs-strong models by task type (per `docs/ai/architecture.md`'s
  cost-control section) is real future work once there's usage data to
  route on.
- **Usage tracking exists; budget enforcement doesn't yet.** Every
  `chat()` call writes one `AiUsageLog` row (`ai-usage.service.ts`) --
  organizationId, tokens, cost (when OpenRouter reports it), latency,
  status, on both success and failure paths, logging failure itself never
  able to fail the actual response. What's still missing: nothing reads
  this table to enforce a limit yet -- `docs/saas/plans-and-limits.md`'s
  "AI usage" plan limit still needs a `LimitsService` check wired into
  `AiService.chat()` before this data does more than sit there for
  after-the-fact reporting.
- **No prompt-injection test suite.** The system prompt instructs the
  model to treat tool-result content as data, not instructions (the
  standard mitigation), but nothing automated verifies this holds --
  see `docs/security/overview.md`'s test matrix, still marked N/A for AI.

## Environment variables

- `OPENROUTER_API_KEY` -- optional. Without it, `/ai/chat` returns a
  clear `503`, not a boot failure.
- `OPENROUTER_MODEL` -- defaults to `anthropic/claude-3.5-sonnet`.
