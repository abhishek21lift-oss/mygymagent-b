# Webhook subscriptions (outgoing) — design

Date: 2026-10-09. Approved in chat before writing.

## Goal

Gyms connect n8n/Zapier-style tools: register a URL, pick events, and
receive a signed JSON POST whenever those WhatsApp events happen.
Mirrors WA-AKG's outgoing webhooks (`src/lib/webhook.ts`: per-session
URL + events + secret, HMAC-SHA256 `X-Webhook-Signature`, delivery
log, test endpoint), rebuilt on this repo's primitives.

## Non-goals

- Incoming webhooks (Meta-style receiver). Nothing listens for external
  POSTs; traffic is outward only.
- WA-AKG events with no counterpart here (`group.update`,
  `contact.update`, `status.update`, `group.participant`,
  `message.deleted/edited`). No domain source emits them.
- Full payload archiving. Delivery rows store status, not bodies (PII).

## Data model (Prisma, backend repo)

`WebhookSubscription`: id, organizationId (cascade), url, events
(String array, `"*"` allowed), secret (random 32 bytes hex,
auto-generated at create, never returned by list), enabled, createdBy,
timestamps. Unique `(organizationId, url)`.

`WebhookDelivery`: id, subscriptionId (cascade), organizationId, event,
status (`PENDING | SENT | FAILED`), attempts, httpStatus (nullable),
error (nullable, truncated 500 chars), nextRetryAt (nullable),
timestamps. Index `(organizationId, createdAt)` for the log view.
Retention: rows older than 30 days deleted by the existing
data-retention scanner pattern (new scanner case, no new cron).

## Events and emit points

| Event | Emitted when | Source |
|---|---|---|
| `message.received` | inbound text filed | `WhatsappInboundFiler.file/fileGroup`, after row create |
| `message.sent` | our reply/auto-reply/broadcast leg sent | wa-send processor success path |
| `message.failed` | a send leg fails terminally | wa-send processor failure path |
| `broadcast.finished` | broadcast reaches DONE/CANCELLED | broadcast settle path |
| `connection.update` | own-number session links/disconnects | session manager `connection.update` handler |
| `test` | user presses Test in UI | test endpoint only, never emitted |

Payload: `{ event, organizationId, timestamp, data }`. `data` is the
small existing shape (inbound row / message log row / broadcast row /
session status) — no new serializers beyond picking fields.

## Dispatch (BullMQ, recommended approach A)

Emit point loads the org's enabled subscriptions matching the event
(or `"*"`), then enqueues one job per subscription on a new
`wa-webhooks` queue (same `BullModule.registerQueue` pattern as
`WA_SCHEDULED`). Processor POSTs JSON with `X-Webhook-Signature:
sha256=<hmac(secret, rawBody)>`, 10s timeout. Attempts: 3 total,
exponential backoff with jitter; terminal fail writes `FAILED` +
httpStatus/error. Each attempt upserts the delivery row. Queue
concurrency 5; per-org ordering not guaranteed (documented).

## Security (non-negotiable)

- **SSRF block.** The URL is user-supplied and fetched server-side:
  resolve hostname, refuse loopback/link-local/private ranges and
  cloud metadata IPs (169.254.169.254), allow only http/https, refuse
  redirects to blocked targets (max 2 redirects, re-check each hop).
  Test path: `WEBHOOK_ALLOW_PRIVATE_URLS` (comma-separated, default
  empty; `.env.test` sets `127.0.0.1`) so e2e can run a local receiver
  without weakening production.
- **Secret hygiene.** Auto-generated, returned once at create;
  `GET` list/detail never includes it; `POST /:id/regenerate` rotates.
- **Abuse caps.** Max 10 subscriptions per org; dispatch fan-out capped
  at 10 jobs per event; BullMQ worker `limiter: { max: 20, duration: 1_000 }`
  on the delivery processor so a flapping receiver can't cause a retry
  storm. Controller throttled like the auto-replies one.
- **PII.** Bodies travel to the user's own URL (their choice) but are
  never persisted in delivery rows or logs.

## API (backend, `whatsapp.manage` / `whatsapp.read` for log)

- `GET /whatsapp/webhooks` — list (no secrets).
- `POST /whatsapp/webhooks` — `{ url, events[], }` → row + secret
  returned once. URL + events validated; invalid event names 400.
- `PATCH /whatsapp/webhooks/:id` — url/events/enabled; secret never
  via this route.
- `DELETE /whatsapp/webhooks/:id` → `{ deleted: true }`.
- `POST /whatsapp/webhooks/:id/test` — sends `test` event immediately
  (single attempt), returns delivery outcome.
- `POST /whatsapp/webhooks/:id/regenerate` — new secret, once.
- `GET /whatsapp/webhooks/deliveries?limit=` — newest-first log.
  All org-scoped (`updateMany`/`deleteMany` pattern: another org's id → 404).

## Frontend (settings WhatsApp card)

`WebhooksCard` beside `AutoRepliesCard`: subscription list (url,
events badges, enabled toggle, last-delivery status dot), add/edit
dialog (URL field, event checkboxes for the 5 events + all, enabled),
secret shown once after create with copy button + regenerate, Test
button per row, recent-deliveries mini-table (event, status,
attempts, error, time). Hook `use-webhooks.ts` + test, same shape as
`use-auto-replies`.

## Testing

- Unit: HMAC signer (known vector), event-match (`"*"` + subset),
  SSRF guard (loopback/private/metadata refused, public allowed),
  URL/event validation 400s.
- E2E: subscribe → inbound message → fake receiver gets signed POST
  with valid signature; receiver 500s → 3 attempts then FAILED row;
  `#` unrelated: `test` endpoint delivers once.
- Gates: backend typecheck + eslint + unit, frontend typecheck +
  eslint + hook test, then the two affected e2e suites
  (whatsapp-autoreply, whatsapp-web) as regression.

## Rollout

Backend migration + queue registration first, then controller, then
frontend card. Single PR per repo, merge + push like P1–P4. No
dependency on WA-AKG repo (reference only, still pending deletion).
