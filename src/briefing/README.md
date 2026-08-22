# briefing

**Status: implemented (P3 scope).** The Owner Daily Briefing: one real, computed report
aggregating what P1's Revenue & Finance and P2's Member/Sales/Trainer/Inventory intelligence
already made queryable one endpoint at a time, plus P3's own Action Center backlog.

## What exists

- **`GET /briefing/daily`** (`daily-briefing.controller.ts`, `reports.view`) -- returns:
  - `today.checkIns` -- real-time count of today's (UTC calendar day) check-ins.
  - `revenue` -- this month's `RevenueSummary` from `FinanceService.getRevenueSummary()`,
    `notComputable` disclosure included verbatim.
  - `atRiskMembers` -- count plus the top 5 most-at-risk (from
    `MemberIntelligenceService.getAtRiskMembers()`); the full list is still available at
    `GET /analytics/members/at-risk` for anyone who needs every row.
  - `salesFunnel` -- this month's `SalesFunnel` from `SalesIntelligenceService.getFunnel()`.
  - `lowStock` -- count plus the top 5 soonest-to-stock-out products at or below their reorder
    level, filtered from `InventoryIntelligenceService.getStockForecast()`.
  - `trainerWorkload` -- trainer count plus the top 5 by assigned-member load, with the same
    PT-specific `notComputable` disclosure `TrainerIntelligenceService.getWorkload()` returns.
  - `pendingAiActions` -- how many `AiAction` rows are `PENDING_APPROVAL` right now
    (`AiActionsService.countPending()`), so an owner sees at a glance whether anything is
    waiting on them in the Action Center (`src/ai-actions/`) without a separate request.
- **`get_daily_briefing`** -- the same aggregation as an AI tool (empty args, gated on
  `reports.view` via `resolveAccess()`, exactly like the 5 P2 intelligence tools), so the
  assistant can answer "how are we doing today" with one tool call instead of five.

## Why this is aggregation, not a new data source

Every field traces back to a service `src/analytics/` or `src/ai-actions/` already exposes over
its own endpoint -- this module adds no new computation, no new table beyond what those modules
already own, and no new permission tier (`reports.view`, the same one `GET /analytics/*` already
uses). The point is that a caller who wants "what does today look like" doesn't have to make six
requests and mentally merge them; `DailyBriefingService.getDailyBriefing()` does that merge once,
in parallel (`Promise.all`), and returns one real, honest snapshot -- honest in the same sense
`FinanceService`/`TrainerIntelligenceService` are: every `notComputable` disclosure those services
already return is preserved here, not dropped in the rollup.

## What's still out of scope

- No scheduled delivery (e.g. an email each morning). This is a pull endpoint; an
  `Automation`-style scheduled push (see `src/automation/README.md`'s BullMQ-repeatable-job
  pattern) would be the natural way to add one, once there's a real notification channel an owner
  has asked for it on.
- No historical briefing snapshots -- every call recomputes live from current data. If "what did
  yesterday's briefing say" ever becomes a real need, that's a new persistence decision, not an
  extension of this endpoint.
- No narrative/AI-generated summary text baked into the response -- the data is structured JSON;
  turning it into prose is exactly what the assistant already does when a user calls
  `get_daily_briefing` through `/ai/chat`, so building a second, server-side text-generation path
  here would duplicate that for no benefit.
