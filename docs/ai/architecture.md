# AI architecture

## Status
This was written as a design-only doc before the `ai` module existed (per ADR 0004 — breadth
domains got a design pass before code, since an under-designed AI integration is how you get
`execute_sql()` handed to a model). **The module is now built** — v1 scope, not the full pipeline
below. See `src/ai/README.md` for exactly what exists vs. what's still a deliberate v1
simplification (no conversation persistence, no model routing, no budget enforcement yet, no
approval queue — v1's write tools are safe by construction instead). The layered pipeline below is
still the target shape for where this grows, not a description of what runs today.

## Layers

```
Client request
      ↓
AI Gateway (single entry point — auth, quota check, org-level feature-flag check)
      ↓
Model Router (picks provider/model per task type + cost tier)
      ↓
Provider Adapter (Anthropic / OpenAI / etc. — isolated behind one interface)
      ↓
Agent (a bounded task: "generate a workout draft", "score a lead") with an explicit tool allowlist
      ↓
Tools (read_member, read_attendance, create_workout_draft, ... — never a generic query capability)
      ↓
Structured Output Validation (schema-checked before anything touches the DB)
      ↓
Domain service (the same services the REST API uses — the AI layer is a caller, not a bypass)
```

## §56 — Explicit tool allowlist (the hard rule)

Tools are named, scoped, single-purpose functions, not query access. Planned initial set:

```
read_member(memberId)              -- returns a defined subset of Member fields, org-scoped
read_workout_history(memberId)     -- once workouts exist
read_attendance(memberId, range)   -- aggregate/summarized, not raw row dump (see data-ownership.md)
create_workout_draft(memberId, ...)-- writes a DRAFT, never auto-published
create_diet_draft(memberId, ...)   -- same
create_followup(memberId, note)    -- CRM follow-up task, once CRM exists
```

**Never**: `execute_sql()`, `query_database()`, or any tool whose input is itself a query/filter
object broad enough to reconstruct arbitrary access. Every tool's implementation calls the same
tenant-scoped domain service the REST API uses (e.g. `MembersService.findOne(id, organizationId)`)
— the AI layer gets no special-cased data-access path that bypasses RBAC/tenant scoping. An AI
request acts *as* the authenticated user who invoked it (or a scoped system identity for background
jobs), never as an unscoped superuser.

## §57 — Structured outputs, validated before persistence

Every AI-generated artifact that gets saved has a schema (planned: Zod, matching the pattern
`nestjs-zod` already uses elsewhere in this backend):

```
WorkoutPlanSchema
DietPlanSchema
LeadScoreSchema
ProgressAnalysisSchema
```

Flow: model returns JSON → validate against schema → on failure, retry with the validation error fed
back to the model (bounded retry count, e.g. 2) → on repeated failure, surface an error to the
caller, **never** save a manually-patched or partially-valid object. Raw LLM output never reaches a
`prisma.create`/`update` call directly — it always passes through the schema first.

## §58 — Cost control

- **Model routing**: cheap/fast model for classification-style tasks (lead scoring, tagging), a
  stronger model reserved for generation tasks (workout/diet plan drafting) where quality matters
  more than latency/cost.
- **Token/context limits**: hard caps per request type, not "whatever fits" — a workout-generation
  prompt has a bounded context window (member profile + recent history summary, not their entire
  attendance log).
- **Caching**: cache stable inputs (e.g. an exercise library lookup a prompt references repeatedly)
  rather than re-sending them every call, once prompt-caching-worthy patterns exist.
- **Per-tenant usage tracking**: built — every `chat()` call writes an `AiUsageLog` row
  (`organizationId`, token count, cost when the provider reports it, latency, status), on both
  success and failure paths. **Budget controls are not built** — nothing reads this table to reject
  a request yet; that's the remaining piece `docs/saas/plans-and-limits.md`'s "AI usage" plan limit
  needs.
- **Rate limits**: per-org and per-user request-rate caps, independent of the general API throttle,
  since a single runaway AI feature (e.g. a UI bug that re-triggers generation in a loop) is a much
  larger cost event than a runaway REST call.

## Guardrails / security

- Prompt injection: user-supplied content (member notes, chat messages) that flows into a prompt is
  treated as untrusted — never string-concatenated into a system-level instruction; tool definitions
  and system prompts stay separate from user-content channels in whatever SDK/framework is used.
- An AI agent's effective permissions are the invoking user's permissions, full stop — see the tool
  allowlist section above. "AI agent → unauthorized data" is listed as not-yet-testable in
  `docs/security/overview.md`'s matrix precisely because there's no AI module yet to test; this
  design is what that future test suite will verify against.

## Memory

Per-conversation history, tenant-scoped, retained per `docs/database/data-retention.md`'s AI-
conversations section (not used as training data without explicit per-org opt-in). No cross-tenant
memory/context sharing, ever — including for a hypothetical "learn from all our customers" feature,
which would need to be built as anonymized/aggregated analytics, not shared raw conversation memory.
