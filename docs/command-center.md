# Command Center

Read-only operational telemetry for the whole deployment. Platform staff only.

`GET /platform/command-center/snapshot?refresh=true`

## What it is

One endpoint returning every card, each graded independently:

| Card | Source | Answers |
|---|---|---|
| `readiness` | the same two dependencies `GET /ready` probes | can this instance serve traffic |
| `queues` | BullMQ depth via the existing shared `QueueConnection` | is the work keeping up |
| `ai` | `AiUsageLog` + `AiAction` | what is AI costing, and what is waiting on a human |

Deliberately **not** built yet: host CPU/memory/disk, Docker, and HTTP request
latency. See "What is deliberately absent".

## The one rule everything else serves

**A card that could not be measured carries `value: null` — never 0.**

"0 failed jobs" and "we could not read the queue" lead to opposite decisions,
and on a monitoring console the second is the more dangerous one to confuse
with the first. Every collector is individually timeout-guarded, so one dead
dependency degrades one card rather than failing the snapshot.

Three states, and the difference is visible without reading prose:

| status | meaning | rendered as |
|---|---|---|
| `ok` | measured, nothing wrong | the figure |
| `degraded` | measured, something is wrong | the figure + a warning edge |
| `unavailable` | **not measured** | an em dash + the reason. No figure at all |

`unavailable` is deliberately not painted red. A blind spot is not a fault, and
training an operator to ignore the one card that genuinely is red is worse than
the ambiguity.

`telemetry-contract.ts` lists the keys each card must keep carrying. A *rename*
during a refactor breaks that list rather than silently blanking a number on
the console — which is the failure mode a `unknown` payload type produces, and
the reason this file exists.

## Cost is never estimated

`ai.costUsd` sums what OpenRouter reported (`usage: { include: true }`). When
the provider reports no cost it is `null`, never `0` and never derived from a
static per-model rate card. A plausible-looking wrong number here becomes a
billing conversation. Same reasoning as the `AiUsageLog` model comment.

## Caching

A 10-second in-process TTL sits in front, because the console polls every 30s.
Without it, two tabs would each issue a full set of aggregates and four
queue-depth reads for identical data — a self-inflicted load problem on the
page meant to explain load problems. `refresh=true` bypasses it; that is what
the "Re-probe now" button sends.

The cache is a `Map`, deliberately **not** Redis: putting it on the shared
connection would mean a Redis outage could blank the card meant to explain it.

## Authorization

`@RequirePlatformRole()` on the controller, enforced server-side by
`PlatformRoleGuard`. Never `@RequirePermissions(...)` — `PermissionsService`
returns `false` for a null `organizationId`, so a permission here could never
be satisfied by platform staff.

Same reasoning and same trade-off as `PlatformOrganizationsController`; see
ADR 0001. `test/command-center.e2e-spec.ts` proves an ordinary org owner gets
403.

## Queue instances are not duplicated

`CommandCenterModule` imports `NotificationsModule`, `AutomationModule` and
`WhatsappWebModule` rather than calling `BullModule.registerQueue` itself.

Registering a queue name a second time yields a second `Queue` object over the
same Redis keys — so the collector would read through a handle no worker holds.
It also broke `automation-overview.e2e-spec.ts`, whose
`app.get(getQueueToken(AUTOMATION))` spy stopped patching the instance the
service under test used, making a passing degradation test fail. The three
modules now re-export `BullModule`.

## What is deliberately absent

| Missing | Why |
|---|---|
| Host CPU / memory / disk | needs the Docker socket or host `/proc` mounted in. Production's compose file is **not in this repository**, so whether that is possible is unknown. A card that guessed would be worse than no card. |
| Docker / container state | same |
| HTTP request latency | a bounded in-process ring exists (`collectors/http-metrics.ring.ts`) and is tested, but nothing feeds it yet, so no card reports it. The UI says so rather than showing a placeholder. |
| SSE / WebSocket | polling is enough at 30s and needs no new transport, no nginx `Upgrade`, and no socket-auth story. |
| Actions (pause queue, retry failed) | Phase 4. When they land they must be allow-listed, audited, and confirm-gated. Note MY PT STUDIO's `flush cache` was a data-loss bug there: Redis held only BullMQ, so `FLUSHDB` would have deleted pending renewal emails. Same shape here — the queue actions must never grow into a Redis flush. |

## Tests

- `collectors.spec.ts` — the framework guarantees: never throws, never hangs,
  never fabricates a zero.
- `queue.collector.spec.ts` — per-queue isolation; an unreadable queue is
  `null`, not `0`.
- `ai-usage.collector.spec.ts` — provider-reported cost only; `null` stays null.
- `http-metrics.ring.spec.ts` — bounded, cardinality-capped, honest when empty.
- `snapshot.service.spec.ts` — one broken collector degrades one card; TTL reuse.
- `test/command-center.e2e-spec.ts` — authorization, per-card grading, cache
  semantics, and that `refresh=false` is not treated as `true`.
