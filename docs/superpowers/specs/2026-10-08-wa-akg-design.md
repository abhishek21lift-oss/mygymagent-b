# WA-AKG Replacement Design — 2026-10-08

## Intent (agreed)
Replace **both** existing WhatsApp paths in `mygymagent-b` with WA-AKG only:
- Meta Cloud API (`src/whatsapp/` + `MetaWhatsappProvider`)
- In-process Baileys (`src/whatsapp-web/` manager/sender/processor/auth-store)

One shared WA-AKG deployment, **1 session per org** (`sessionId=gym-{organizationId}`).
Backend holds `WA_AKG_BASE_URL + WA_AKG_API_KEY`; WA-AKG webhooks back into backend.
Frontend `use-whatsapp.ts` contract unchanged.

Assumptions: WA-AKG reachable from backend; QR linking happens in WA-AKG dashboard
or proxied through existing settings page; no per-message cost concern (own numbers).

## Approaches considered
- **A — Thin gateway provider (chosen):** one `WaAkgProvider implements MessageProvider`,
  keep CommunicationsService/MessageLog/InboundMessage/filer/auto-reply, keep
  `POST /whatsapp/*` shape. Smallest diff, keeps RBAC/audit.
- B — WA-AKG native (WA-AKG logs as truth, frontend calls WA-AKG): skipped —
  splits history, loses tenant guard/audit.
- C — Strangler flag (dual providers, per-org opt-in): skipped — dual code/webhooks.
  Add when zero-downtime migration is required.

## §1 Architecture & components
- New `src/whatsapp/wa-akg.provider.ts` (`MessageProvider`):
  - `sessionId(orgId) = gym-{organizationId}`, deterministic, no new table.
  - `ensureSession()`: `GET /api/sessions/{id}` else `POST /api/sessions {name:id}`.
  - `send({to,text,organizationId})`: normalize to JID (digits + `@s.whatsapp.net`,
    keep +91 fallback for Indian gyms), `POST /api/messages/{sessionId}/{jid}/send`
    `{message:{text}}` with `X-API-Key: wag_*`, return `waakg:<id>`.
  - `isConfigured()` = `WA_AKG_BASE_URL` + `WA_AKG_API_KEY` present.
  - Env: `WA_AKG_BASE_URL`, `WA_AKG_API_KEY`, `WA_AKG_WEBHOOK_SECRET`.
- Keep-but-rewire: `WhatsappService` (integration/messages/logs/templates/inbound)
  backed by WA-AKG session status + local `MessageLog`; `WhatsappInboundFiler`
  + `WhatsappAutoReplyListener` stay (enabled = WA-AKG CONNECTED).
- Delete: `src/whatsapp-web/` (manager/sender/processor/auth-store/types/factory),
  `meta-whatsapp.provider.ts`, `whatsapp-router.provider.ts`,
  `whatsapp-token.vault.ts`, Meta webhook verify/signature files, Baileys/QR deps,
  `WHATSAPP_WEB_ENABLED`, `META_*`, `WHATSAPP_TOKEN_KEY` paths.

## §2 Data flow
- **Send:** `UI → POST /whatsapp/messages → sendAdHoc → WaAkgProvider → WA-AKG →
  MessageLog SENT (waakg:<id>) / FAILED`. No backend pacing; WA-AKG owns antispam.
  Consent gating in `sendAdHoc` stays; MARKETING no longer refused at provider.
- **Status:** WA-AKG `message.status` → `POST /whatsapp/webhook` (HMAC
  `X-Webhook-Signature`, `WA_AKG_WEBHOOK_SECRET`) → `updateMany providerMessageId`
  SENT→DELIVERED→READ/FAILED. Ack `{received:true}` even unknown.
- **Inbound:** WA-AKG `message.received {sessionId,data:{from,content}}` →
  `orgId` from `gym-` prefix → `WhatsappInboundFiler.file()` →
  `whatsapp.received` → CRM + auto-reply (`fromOwnNumber` always true conceptually).
- **Session UI:** `GET /whatsapp/integration` + `GET /whatsapp-web` return WA-AKG
  `GET /api/sessions/{id}` mapped to CONNECTED/PAIRING/LOGGED_OUT/DISCONNECTED;
  connect proxies QR/pairing; disconnect → WA-AKG stop/logout.

## §3 Errors + testing
- Fail closed: WA-AKG down/401/403 → `ServiceUnavailable`, FAILED row, no fallback.
  Unknown session → ack + warn. Bad signature → 403. Not-on-WhatsApp →
  LOGGED_OUT + `lastError: relink`. Caps/delays configured in WA-AKG, not backend.
- Tests: unit provider (JID, session map, headers, id prefix); webhook HMAC +
  filer routing e2e with mocked WA-AKG HTTP; keep tenant-isolation + auto-reply
  specs (stub enabled=CONNECTED). Manual: QR link → send → reply → status in
  `/settings/whatsapp`.

## Rollout
1. Deploy WA-AKG + set backend env + register backend webhook URL in WA-AKG.
2. Link 1 staging gym session, verify send/reply/status.
3. Delete legacy code + deps, update `.env.example`, run typecheck/lint/unit/e2e/build.
