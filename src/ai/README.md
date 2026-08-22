# ai

**Status: partially implemented (v1-v3 scope, incrementally extended through P3).** A single
tool-calling chat endpoint is real, now with persisted conversation memory and (via
`src/ai-actions/`) an approval flow for the one tool that performs a consequential write. The full
Gateway -> Model Router -> Provider Adapters -> Specialized Agents pipeline described in
`docs/ai/architecture.md` remains scoped down: one provider (OpenRouter), no model routing (one
configured model for everything), and no multi-agent Supervisor -- see "Deliberate simplifications"
below for why, and what would need to change to add one.

## What exists

- `POST /ai/chat` (`ai.generate`) -- takes `{ message, history?, conversationId? }`. Passing
  `conversationId` loads that conversation's real persisted history (authoritative over `history`,
  which only matters for a brand-new conversation -- see `dto/chat.dto.ts`); omitting it starts a
  new conversation, always persisted, whose id comes back in the response for the client to
  continue later. Runs a bounded tool-calling loop (max 6 iterations) against OpenRouter, and
  returns `{ reply, toolCalls, conversationId }` (`toolCalls` is included for transparency/
  debugging in the UI, not just an internal detail).
- **`GET/DELETE /ai/conversations`** (`conversations/`, `ai.generate`) -- a user's own past
  conversations (never another user's, even within the same org -- see "AI memory" below).
- **Explicit tool allowlist** (`tools/tool-definitions.ts`), the v1 set
  `docs/ai/architecture.md` specified (`read_member`,
  `read_workout_history`, `read_attendance`, `create_workout_draft`,
  `create_diet_draft`, `create_followup`) plus 5 P2 read-only
  intelligence tools (`get_revenue_summary`, `get_at_risk_members`,
  `get_sales_funnel`, `get_trainer_workload`, `get_inventory_forecast` --
  each mirrors a real `GET /analytics/*` endpoint, see
  `src/analytics/README.md`) plus 3 P3 tools: `get_daily_briefing` (the
  same 5 reports aggregated into one call, see `src/briefing/README.md`)
  and 2 propose-only tools (`propose_assign_workout_plan`,
  `propose_assign_diet_plan` -- see `src/ai-actions/README.md`). No
  `execute_sql`-shaped tool exists or ever should -- see
  `docs/ai/architecture.md`'s "§56" section.
- **No special-cased data path**: every tool executor
  (`tools/tool-executor.service.ts`) calls the exact same
  organizationId-scoped domain service the REST API uses
  (`MembersService`, `AttendanceService`, `WorkoutPlansService`,
  `WorkoutAssignmentsService`, `DietPlansService`, `LeadsService`, and
  now `FinanceService`/`MemberIntelligenceService`/
  `SalesIntelligenceService`/`TrainerIntelligenceService`/
  `InventoryIntelligenceService` from `src/analytics/`).
  `organizationId` comes from the authenticated caller's JWT
  (`AiController` -> `AiService`), never from anything the model said.
  The 5 intelligence tools are gated on `reports.view` via the same
  `resolveAccess()` every other tool uses -- a caller who can't see
  `GET /analytics/revenue` over REST can't reach `get_revenue_summary`
  through the assistant either.
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

## AI memory (P3)

- `AiConversation`/`AiMessage` (schema, see their comments) persist every `chat()` exchange,
  tenant- and user-scoped. Only natural-language USER/ASSISTANT turns are stored as `content`;
  tool-call mechanics are auxiliary `toolCalls Json?` metadata on the ASSISTANT message, kept for
  transcript viewing but never replayed back into a future prompt as if the model needs to see its
  own past tool calls again -- only the natural-language exchange matters for continuity.
- Soft-delete only (`deletedAt`), per the pre-existing "AI conversations" policy in
  `docs/database/data-retention.md`: hidden from the user via `DELETE /ai/conversations/:id`, but
  the row and its messages survive for the org's audit record. Never used as training data (same
  doc).
- Ownership is per-user, not just per-org -- `AiConversationsService` scopes every read by
  `(organizationId, userId)`, so one org admin's chat history is invisible to another user in the
  same org, including one who could otherwise see everything else about the org.
- The user's message is persisted *before* the provider call (`AiService.chat()`), so a
  conversation and its first turn exist even if the provider call itself then fails (a dead
  `OPENROUTER_API_KEY`, a timeout, a rate limit) -- there's a real record of what was asked, not
  just of what got answered.

## Deliberate simplifications (read before extending this module)

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
- **No multi-agent Supervisor.** There is exactly one tool-calling loop, now with 14 tools across
  reads, drafts, intelligence, aggregation, and propose-only writes -- not a Supervisor that routes a request to
  a "reporting agent" vs. a "member-management agent" per `docs/ai/architecture.md`'s diagram. See
  `ARCHITECTURE_DECISIONS.md` AI-13 and AI-17: nothing built so far has actually needed request
  routing between specialist toolsets, and building that dispatch layer with nothing that requires
  it would be exactly the "flashy AI UI before the operational foundation" the master prompt warns
  against. If a future need for genuinely different tool subsets per request-type appears (not
  just "more tools"), a Supervisor would dispatch to specialist agents that reuse these same typed
  tools and `resolveAccess()`/Action Center patterns, not duplicate them.
- **No global AI command interface.** The master prompt's P3 scope includes a "global AI command
  interface" -- this is a frontend/UI concern (a command palette or omnipresent chat surface), and
  this session's work has only ever touched the `mygymagent-b` backend repo. Nothing here blocks
  building it: `POST /ai/chat` plus `GET /ai/conversations` already give a frontend everything it
  needs (send a message from anywhere, resume any past conversation) to build that surface without
  further backend work.

## Environment variables

- `OPENROUTER_API_KEY` -- optional. Without it, `/ai/chat` returns a
  clear `503`, not a boot failure.
- `OPENROUTER_MODEL` -- defaults to `anthropic/claude-3.5-sonnet`.
