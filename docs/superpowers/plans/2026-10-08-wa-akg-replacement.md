# WA-AKG Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all WHATSAPP traffic in mygymagent-b through shared WA-AKG (1 session per org), deleting Meta Cloud API + in-process Baileys.

**Architecture:** Single `WaAkgProvider implements MessageProvider` bound to `WHATSAPP_PROVIDER`; `WhatsappService` becomes a thin WA-AKG session facade; webhook accepts WA-AKG HMAC shape; everything else (CommunicationsService, MessageLog, filer, auto-reply) unchanged.

**Tech Stack:** NestJS 11, Prisma 6 Postgres, Jest + Supertest, WA-AKG REST (`X-API-Key: wag_*`, HMAC `X-Webhook-Signature`).

**Spec:** `docs/superpowers/specs/2026-10-08-wa-akg-design.md`

## Global Constraints

- Node >= 22 (`package.json:8-10`).
- `sessionId(organizationId) = gym-{organizationId}` verbatim, no new DB table.
- Outbound: `POST {WA_AKG_BASE_URL}/api/messages/{sessionId}/{jid}/send` body `{message:{text}}`, header `X-API-Key`, return `waakg:<id>`.
- JID: digits-only + `@s.whatsapp.net`; keep +91 fallback for Indian gyms only.
- Webhook HMAC over raw bytes with `WA_AKG_WEBHOOK_SECRET`, fail closed (403); ack `{received:true}` even unknown.
- Backend `GET /whatsapp/*` response shapes unchanged (frontend zero changes).
- TDD: failing test first per task; commit per task.

## Review Focus

- Indian local number `98765 43210` → `919876543210@s.whatsapp.net`, not bare digits.
- US local number without country code → FAILED row with clear error, never guessed +91.
- WA-AKG 500/timeout → MessageLog FAILED with errorMessage, never throws past CommunicationsService.
- Webhook with bad signature → 403 and nothing filed.
- Webhook `sessionId=evil-org` (no `gym-` prefix or unknown org) → ack `{received:true}`, no row, warn logged.

---

### Task 1: WaAkgProvider + wiring

**Files:**
- Create: `src/whatsapp/wa-akg.provider.ts`
- Create test: `src/whatsapp/wa-akg.provider.spec.ts`
- Modify: `src/communications/communications.module.ts:12-14,32-47`
- Modify: `src/config/env.validation.ts:157-182`

**Interfaces:**
- Consumes: `MessageProvider.send({to,text,organizationId?,category?,messageLogId?,fromOwnNumber?}) => Promise<string|void|QueuedSend>` (`src/communications/interfaces/message-provider.interface.ts:25-44`).
- Produces: `WaAkgProvider.send(...) => Promise<string>` (returns `waakg:<id>`); `WaAkgProvider.isConfigured() => boolean`; `sessionIdFor(organizationId:string)=>string`; `toJid(phone:string)=>string`.

- [ ] **Step 1: Write failing unit test** in `src/whatsapp/wa-akg.provider.spec.ts`: `toJid("98765 43210")` needs org country — test `sessionIdFor("org_123")==="gym-org_123"`, send posts to `/api/messages/gym-org_123/919876543210@s.whatsapp.net/send` with `X-API-Key` and returns `waakg:ABC`, missing env → `isConfigured()===false`.
- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/whatsapp/wa-akg.provider.spec.ts`
Expected: FAIL with "Cannot find module './wa-akg.provider'"

- [ ] **Step 3: Implement `WaAkgProvider` in `src/whatsapp/wa-akg.provider.ts`** with `sessionIdFor`, `toJid` (strip non-digits, require >=7 digits, prepend 91 only when 10 digits starting 6-9), `ensureSession()` (`GET /api/sessions/{id}`, `POST /api/sessions {name:id}` on 404), `send()` (8s AbortController timeout, `fetch`, parse `{data:{...}}` or `{key:{id}}`, return `waakg:<id>`), `isConfigured()`.
- [ ] **Step 4: Wire provider + env**: `communications.module.ts` bind `{provide: WHATSAPP_PROVIDER, useClass: WaAkgProvider}`, remove `WhatsappWebModule` import; `env.validation.ts` add `WA_AKG_BASE_URL: z.string().url().optional()`, `WA_AKG_API_KEY: z.string().optional()`, `WA_AKG_WEBHOOK_SECRET: z.string().optional()`.
- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/whatsapp/wa-akg.provider.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp/wa-akg.provider.ts src/whatsapp/wa-akg.provider.spec.ts src/communications/communications.module.ts src/config/env.validation.ts
git commit -m "feat(whatsapp): WA-AKG gateway provider"
```

### Task 2: WhatsappService session facade (drop Meta vault)

**Files:**
- Modify: `src/whatsapp/whatsapp.service.ts:1-491`
- Test: `src/whatsapp/whatsapp.service.spec.ts` (new or extend)

**Interfaces:**
- Consumes: `WaAkgProvider.sessionIdFor`, WA-AKG `GET /api/sessions/{id}` → `{status,qr,...}`.
- Produces: `getIntegration(orgId)`, `connect/disconnect(orgId)`, `status(orgId)` shapes unchanged for controller.

- [ ] **Step 1: Write failing test**: `getIntegration` returns `{status:"CONNECTED"}` when WA-AKG session connected (mock fetch); `completeEmbeddedSignup` removed (test asserts method no longer exists or throws 410).
- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/whatsapp/whatsapp.service.spec.ts`
Expected: FAIL (still calls Meta Graph / vault)

- [ ] **Step 3: Rewrite `WhatsappService`**: delete `completeEmbeddedSignup/token/vault/Graph` code; `getIntegration/status/connect/disconnect/testSend/sendMessage/listMessages/listLogs/listTemplates/listInbound` via WA-AKG session GET + local Prisma `MessageLog/MessageTemplate/InboundMessage` reads (keep method names/signatures, keep `sendMessage` delegating to `CommunicationsService.sendAdHoc`).
- [ ] **Step 4: Run tests**

Run: `npx jest src/whatsapp/whatsapp.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/whatsapp.service.ts src/whatsapp/whatsapp.service.spec.ts
git commit -m "feat(whatsapp): service backed by WA-AKG sessions"
```

### Task 3: Webhook receiver swap (Meta → WA-AKG)

**Files:**
- Modify: `src/whatsapp/whatsapp.controller.ts:146-183`
- Modify: `src/whatsapp/whatsapp.service.ts` (`verifyWebhook/verifyInboundSignature/handleWebhook`)
- Test: `src/whatsapp/whatsapp.controller.spec.ts` or e2e `test/whatsapp-webhook.e2e-spec.ts`

**Interfaces:**
- Consumes: `WhatsappInboundFiler.file(orgId, from, body)` (`src/whatsapp/whatsapp-inbound.filer.ts:26-39`).
- Produces: `POST /whatsapp/webhook` accepts `{event,sessionId,timestamp,data}` + `X-Webhook-Signature`, returns `{received:true}`.

- [ ] **Step 1: Write failing test**: POST WA-AKG `{event:"message.received",sessionId:"gym-org1",data:{from:"9198...",content:"Hi"}}` with valid HMAC → 200 + `InboundMessage` row; bad signature → 403; unknown session → 200 + no row.
- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/whatsapp/whatsapp.controller.spec.ts`
Expected: FAIL (expects Meta `hub.*`/`X-Hub-Signature-256`)

- [ ] **Step 3: Implement**: delete Meta `GET webhook` verify + `X-Hub-Signature-256`; add `verifyWaAkgSignature(rawBody, sig)` (HMAC-SHA256 hex, timingSafeEqual, fail closed); `handleWebhook` routes `message.received→filer`, `message.status→updateMany providerMessageId`; resolve org by stripping `gym-` prefix + `Organization.exists` check.
- [ ] **Step 4: Run tests**

Run: `npx jest src/whatsapp/whatsapp.controller.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/whatsapp.controller.ts src/whatsapp/whatsapp.service.ts
git commit -m "feat(whatsapp): WA-AKG webhook receiver"
```

### Task 4: Auto-reply + CommunicationsService cleanup

**Files:**
- Modify: `src/automation/whatsapp-auto-reply.listener.ts:166-177`
- Modify: `src/communications/communications.service.ts:255-275`
- Test: extend `src/automation/whatsapp-auto-reply.intents.spec.ts` or listener spec

**Interfaces:**
- Consumes: `WhatsappService.status/getIntegration` (CONNECTED check).
- Produces: `enabled(orgId)=>boolean` true iff WA-AKG session CONNECTED + `autoReply` on.

- [ ] **Step 1: Write failing test**: `enabled()` returns true with WA-AKG CONNECTED stub even when `WHATSAPP_WEB_ENABLED` unset; `sendAdHoc` with `fromOwnNumber:true` routes via `WHATSAPP_PROVIDER` (no router branch).
- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/automation/whatsapp-auto-reply.intents.spec.ts`
Expected: FAIL (checks `ownWhatsappNumberLinked`/`whatsappWebSession`)

- [ ] **Step 3: Implement**: `enabled()` → WA-AKG status check; `ownWhatsappNumberLinked/ownWhatsappNumberReady` → delegate to WA-AKG CONNECTED (keep names for callers, delete `WHATSAPP_WEB_ENABLED` gate); keep `fromOwnNumber` param accepted but ignored (always own number now).
- [ ] **Step 4: Run tests**

Run: `npx jest src/automation/ src/communications/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/automation/whatsapp-auto-reply.listener.ts src/communications/communications.service.ts
git commit -m "feat(whatsapp): auto-reply via WA-AKG session"
```

### Task 5: Deletion + gates

**Files:**
- Delete: `src/whatsapp-web/` (all), `src/communications/providers/meta-whatsapp.provider.ts`, `src/communications/providers/whatsapp-router.provider.ts`, `src/whatsapp/whatsapp-token.vault.ts`, `src/whatsapp/whatsapp-token.vault.spec.ts`, `src/whatsapp/whatsapp-webhook-signature.spec.ts`
- Modify: `src/app.module.ts` (drop `WhatsappWebModule`), `.env.example`, `package.json` (drop `baileys/qrcode` if unused elsewhere — check `grep -r baileys src`)

**Interfaces:**
- Consumes: nothing new. Produces: green gates.

- [ ] **Step 1: Delete files + remove imports/env vars** (`META_APP_ID/SECRET, WHATSAPP_GRAPH_VERSION, WHATSAPP_TOKEN_KEY, META_WABA_VERIFY_TOKEN, WHATSAPP_WEB_ENABLED/MIN_GAP/JITTER/PAIRING_TIMEOUT` → replaced by `WA_AKG_*` in `.env.example`).
- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors

- [ ] **Step 3: Run lint + unit**

Run: `npm run lint:ci && npx jest src/whatsapp src/communications src/automation`
Expected: PASS

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(whatsapp): remove legacy Meta + Baileys stack"
```
