# WA-AKG Gateway Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all gym WhatsApp traffic through the external WA-AKG gateway instead of the in-process Baileys stack, one gym at a time, with zero frontend changes.

**Architecture:** Add a `WaAkgGatewayProvider` behind the existing `WHATSAPP_PROVIDER` symbol, chosen per-organization by env flag; mirror link-status/QR/inbound shapes so `mygymagent-f` never notices; harden WA-AKG's must-fix bugs first; delete the in-process stack only after the last gym migrates.

**Tech Stack:** NestJS 10, Prisma (MySQL), BullMQ, Jest, `fetch` (Node 20+ global, same as `HttpChannelProvider`).

**Spec:** Chat discussion 2026-10-11 (WhatsApp audit + "bina ban" migration strategy). No separate spec doc — this plan IS the spec; executor reads it plus the cited files.

## Global Constraints

- No change to `mygymagent-f`: every `GET/PATCH /whatsapp-web` and `POST /whatsapp/*` response shape stays byte-compatible.
- `MARKETING` category is always refused (anti-ban rule survives the move).
- Every WhatsApp query stays `organizationId`-scoped; cross-tenant mistakes return 404/400, never 403/404 swaps (existing discipline).
- Env additions go through `src/config/env.validation.ts` (zod) — never raw `process.env` (existing violation `webhook-ssrf.ts:67` is grandfathered, not repeated).
- Each task commits atomically; `npm run build` (tsc) + `npx jest <spec>` green before commit.

## Review Focus

- A gateway timeout after WA-AKG already sent produces a duplicate on retry — a reasonable person expects scheduled/broadcast sends to never double-send; pinned in Task 6.
- A replayed/forged `POST /whatsapp/gateway-inbound` must not create inbox rows — pinned in Task 7.
- QR polling during `PAIRING` must return `{qrDataUrl, pairingCode}` in the exact old shape or the settings card breaks — pinned in Task 5.
- An org NOT in the pilot list must keep the exact old code path (no behavior change for unmigrated gyms) — pinned in Task 3.
- Image sends must keep working (10 MB cap, org-scoped `File.id`, never raw S3 key) — pinned in Task 4.

---

### Task 0: Fix WA-AKG's send-twice scheduler (in WA-AKG repo)

**Files:**
- Modify: `WA-AKG/src/modules/whatsapp/scheduler.ts` (delete file, 79 lines)
- Modify: `WA-AKG/src/server/index.ts:57` (remove dynamic import)
- Test: none exists (WA-AKG has zero test infra) — verify with build + curl.

**Interfaces:**
- Consumes: nothing.
- Produces: single scheduler owner `src/lib/cron.ts` (1-minute tick).

- [ ] **Step 1: Delete the file and its import**

Delete `WA-AKG/src/modules/whatsapp/scheduler.ts`. In `WA-AKG/src/server/index.ts` remove line 57 (`import("../modules/whatsapp/scheduler").then(m => m.startScheduler());`). `initScheduler()` in `manager.ts:13` stays — it is the surviving scheduler.
- [ ] **Step 2: Verify**

Run: `cd WA-AKG && npm run build` Expected: `EXIT=0`. Then boot dev, `POST` one scheduled message due in 1 minute, assert exactly one `message.sent` webhook arrives.
- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: remove duplicate 30s scheduler, cron.ts owns scheduled sends"
```

### Task 1: Harden WA-AKG inputs (in WA-AKG repo)

**Files:**
- Modify: `WA-AKG/src/app/api/sessions/route.ts:33-41` (validate custom `sessionId`)
- Modify: `WA-AKG/src/app/api/media/route.ts:173-181` + `WA-AKG/src/app/api/media/[filename]/route.ts:43-49` (deny on unparsable session)
- Modify: `WA-AKG/src/app/api/messages/[sessionId]/broadcast/route.ts:8-12` (delay bounds)
- Test: manual curl (no test infra).

**Interfaces:**
- Consumes: nothing.
- Produces: gateway safe to expose to `mygymagent-b` with a service API key.

- [ ] **Step 1: Validate `sessionId` at creation**

In `POST /api/sessions`, after the `name` check: `if (sessionId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) return 400`. (Our slugs are `gym-{cuid}` — lowercase, fits.)
- [ ] **Step 2: Fail closed on unparsable media filenames**

In both media files, replace `if (sessionId) { check }` with `if (!sessionId) return 403; check`.
- [ ] **Step 3: Bound broadcast delay**

`delay: z.number().min(500).max(60000)` (same rule already in `src/lib/validations.ts:19`) and `recipients: z.array(z.string()).max(5000)`.
- [ ] **Step 4: Verify**

Run: `npm run build` → `EXIT=0`. Curl: `POST /api/sessions {name:"x",sessionId:"../../evil"}` → 400; `DELETE /api/media {filenames:[".gitkeep"]}` → 403; broadcast with `delay:-5` → 400.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: validate sessionId, fail-closed media auth, bound broadcast delay"
```

### Task 2: Gateway env config + per-org kill switch (in `mygymagent-b`)

**Files:**
- Modify: `mygymagent-b/src/config/env.validation.ts` (append 4 vars near `FRONTEND_URL`)
- Test: `mygymagent-b/src/config/env.validation.spec.ts` (extend — assert gateway vars optional, `WA_GATEWAY_URL` must be URL when set)

**Interfaces:**
- Consumes: nothing.
- Produces: `WA_GATEWAY_URL`, `WA_GATEWAY_API_KEY`, `WA_GATEWAY_ORG_IDS`, `WA_GATEWAY_WEBHOOK_SECRET` via `ConfigService`; helper `isGatewayOrg(organizationId): boolean` (exact name) exported from new `src/whatsapp/wa-gateway.config.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it('accepts empty gateway config (old path)', () => {
  expect(() => parse({ ...base, WA_GATEWAY_URL: '' })).not.toThrow();
});
it('rejects non-URL gateway', () => {
  expect(() => parse({ ...base, WA_GATEWAY_URL: 'not-a-url' })).toThrow();
});
```

Match the existing spec's `parse` helper style first — read `env.validation.spec.ts:1-60` before writing.
- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/config/env.validation.spec.ts` Expected: FAIL (unknown keys rejected or URL unchecked).
- [ ] **Step 3: Implement**

Add to schema: `WA_GATEWAY_URL: z.string().url().optional()`, `WA_GATEWAY_API_KEY: z.string().min(10).optional()`, `WA_GATEWAY_ORG_IDS: z.string().default('')` (comma-separated, `'*'` = all), `WA_GATEWAY_WEBHOOK_SECRET: z.string().min(16).optional()`. Create `src/whatsapp/wa-gateway.config.ts`:

```ts
export function isGatewayOrg(config: ConfigService, organizationId: string): boolean
```

true only when URL+KEY set AND (`ORG_IDS === '*'` or list includes id). Empty list = no org migrates (safe default).
- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/config/env.validation.spec.ts` Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/config/env.validation.ts src/config/env.validation.spec.ts src/whatsapp/wa-gateway.config.ts
git commit -m "feat: gateway env config with per-org kill switch"
```

### Task 3: `WaAkgGatewayProvider` text send + factory wiring

**Files:**
- Create: `mygymagent-b/src/whatsapp/wa-gateway.provider.ts`
- Modify: `mygymagent-b/src/communications/communications.module.ts:41-44` (`WHATSAPP_PROVIDER` → `useFactory`)
- Test: `mygymagent-b/src/whatsapp/wa-gateway.provider.spec.ts` (new; mirror `wa-akg.provider.spec.ts` mock style)

**Interfaces:**
- Consumes: `isGatewayOrg` (Task 2), `toJid` (import from `./wa-akg.provider`, already exported), `MessageProvider` contract (`message-provider.interface.ts:25-52`).
- Produces: `WaAkgGatewayProvider implements MessageProvider`; factory picks it per-org, else old `WaAkgProvider`. Provider id prefix `waakg-gw:<id>` (exact string, Task 6 depends on it).

- [ ] **Step 1: Write the failing test**

```ts
it('refuses MARKETING like the old path', async () => {
  await expect(provider.send({ to: '+919876543210', text: 'x', organizationId: 'o1', category: 'MARKETING' })).rejects.toThrow(ForbiddenException);
});
it('posts text to the gateway and returns waakg-gw id', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { key: { id: 'ABC' } } }) });
  await expect(provider.send({ to: '+919876543210', text: 'hi', organizationId: 'o1' })).resolves.toBe('waakg-gw:ABC');
});
it('throws ServiceUnavailable when gateway env missing', ...);
```

Mock global `fetch`; mock `PrismaService.organization.findUnique` → `{ currency: 'INR', timezone: 'Asia/Kolkata' }`.
- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp/wa-gateway.provider.spec.ts` Expected: FAIL (file missing).
- [ ] **Step 3: Implement `WaAkgGatewayProvider`**

`isConfigured()`: URL+KEY set. `send()`: throw `ServiceUnavailableException` if unconfigured/org missing (same message as old provider); `ForbiddenException` on `MARKETING`; JID via `to.includes('@') ? to : toJid(to, org)`; `POST ${URL}/api/messages/${sessionIdFor(orgId)}/${encodeURIComponent(jid)}/send` with `X-API-Key`, body `{ message: { text } }`, 20 s `AbortSignal.timeout`; non-`ok` or `!status` → throw `Error('Gateway HTTP …')` (so `CommunicationsService` marks FAILED exactly like today); return `` `waakg-gw:${data?.key?.id ?? data?.id ?? Date.now()}` ``. Factory in module:

```ts
{ provide: WHATSAPP_PROVIDER, useFactory: (config: ConfigService, old: WaAkgProvider, gw: WaAkgGatewayProvider) =>
  ({ send: (m) => (m.organizationId && isGatewayOrg(config, m.organizationId) ? gw : old).send(m),
     isConfigured: () => old.isConfigured() || gw.isConfigured() }) satisfies MessageProvider,
  inject: [ConfigService, WaAkgProvider, WaAkgGatewayProvider] }
```

Register both providers as classes. Unmigrated orgs hit the old path untouched (Review Focus #4 — add a test asserting factory delegates when org not listed).
- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp/wa-gateway.provider.spec.ts src/whatsapp/wa-akg.provider.spec.ts` Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/wa-gateway.provider.ts src/whatsapp/wa-gateway.provider.spec.ts src/communications/communications.module.ts
git commit -m "feat: gateway WhatsApp provider behind per-org flag"
```

### Task 4: Gateway image sends (no media regression)

**Files:**
- Modify: `mygymagent-b/src/whatsapp/wa-gateway.provider.ts` (add `mediaKey` branch)
- Test: extend `wa-gateway.provider.spec.ts`.

**Interfaces:**
- Consumes: `FileStorageService.download` (same call `wa-send.processor.ts:132-153` uses), org-scoped `File` row check (same as `whatsapp.service.ts:144-183`).
- Produces: image sends via `POST {GW}/api/messages/{session}/{jid}/media` (multipart `file/type/caption`).

- [ ] **Step 1: Write the failing test**

```ts
it('sends mediaKey images as multipart, rejects >10MB', ...);
it('rejects foreign-org File.id with 400, not 404', ...); // cross-tenant discipline
```

Mirror the old assertions: 10 MB cap, `image/*` mimetype, org-scoped lookup.
- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp/wa-gateway.provider.spec.ts` Expected: FAIL.
- [ ] **Step 3: Implement**

When `message.mediaKey` set: load `File` by `{id, organizationId}` (400 if missing/foreign — copy the old error text); reject non-`image/*` and `>10 MB`; `download` → `FormData {file: Blob([buf], {type: mimetype}), type: 'image', caption: text}` → POST media route; return `waakg-gw:` id from response. Non-image types (`video/audio/document`) throw `BadRequestException` (gateway+old path both image-only today — no scope creep).
- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp/wa-gateway.provider.spec.ts` Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/wa-gateway.provider.ts src/whatsapp/wa-gateway.provider.spec.ts
git commit -m "feat: gateway image sends with org-scoped 10MB guard"
```

### Task 5: Link-status/QR/connect via gateway (frontend sees nothing change)

**Files:**
- Modify: `mygymagent-b/src/whatsapp-web/whatsapp-web.service.ts` (`status/connect/disconnect/updateSettings` gain gateway branch)
- Modify: `mygymagent-b/src/whatsapp-web/whatsapp-web.service.spec.ts` (extend)
- Test: same spec file.

**Interfaces:**
- Consumes: `isGatewayOrg`, gateway `GET /api/sessions/{id}` (`{status, qr?...}` shape incl. `botConfig/webhooks/_count` — read only `status`), `GET /api/sessions/{id}/qr` → `{success, qr, base64}`, `POST /api/sessions {name, sessionId}`, `POST /api/sessions/{id}/start|stop`, pairing via `POST /api/sessions/{id}/pair {phoneNumber}`.
- Produces: identical response shape to today (`available, status, phoneNumber, qrDataUrl, pairingCode, sentLast24h, dailyLimit, useForSending, autoReply, lastError`). Also fix `sentLast24h` count to include the new prefix (see step 3).

- [ ] **Step 1: Write the failing test**

```ts
it('gateway org: maps gateway CONNECTED to status passthrough with qrDataUrl null', ...);
it('gateway org: PAIRING returns qrDataUrl from /qr base64', ...);
it('sentLast24h counts waakg-gw: rows too', ...);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp-web/whatsapp-web.service.spec.ts` Expected: FAIL.
- [ ] **Step 3: Implement**

Branch on `isGatewayOrg(config, organizationId)` at the top of each method. Gateway `status()`: prefs row (unchanged) + `GET session` → map `CONNECTED/SCAN_QR/DISCONNECTED/LOGGED_OUT/STOPPED` → `CONNECTED/PAIRING/DISCONNECTED/LOGGED_OUT/DISCONNECTED`; `phoneNumber` only when connected; `qrDataUrl = live===PAIRING ? (await GET /qr).base64 : null`. `connect()`: `POST /api/sessions {name: org name, sessionId: sessionIdFor(org)}` (ignore 409-already-exists), then `/{id}/start` (or `/pair` when `dto.phoneNumber`), prefs upsert identical to today. `disconnect()`: `/{id}/stop`, prefs update identical. `updateSettings()`: prefs-only (unchanged) but liveness check uses gateway status. Fix count: `providerMessageId: { startsWith: 'waakg:' }` → `OR: [{ startsWith: 'waakg:' }, { startsWith: 'waakg-gw:' }]` (note: `'waakg-gw:x'.startsWith('waakg:')` is FALSE — `-` ≠ `:` — so the OR is required, not cosmetic).
- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp-web/` Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/whatsapp-web/whatsapp-web.service.ts src/whatsapp-web/whatsapp-web.service.spec.ts
git commit -m "feat: gateway link-status and QR with identical response shape"
```

### Task 6: Restore scheduled retries + gateway daily-cap (anti-ban survives)

**Files:**
- Modify: `mygymagent-b/src/whatsapp/scheduled-message.service.ts:94-133` (rethrow, mark FAILED only on last attempt)
- Modify: `mygymagent-b/src/whatsapp/wa-gateway.provider.ts` (429 cap check before send)
- Test: `mygymagent-b/src/whatsapp/scheduled-message.service.spec.ts` + `wa-gateway.provider.spec.ts`.

**Interfaces:**
- Consumes: BullMQ `Job` attempts metadata (`job.attemptsMade` — change `fire(id)` to `fire(id, job?)`; processor passes it).
- Produces: transient errors retry (3×/60 s per existing job opts); gateway sends refuse over-cap with `TooManyRequestsException` using the org's `dailyLimit` (default 200, same as prefs).

- [ ] **Step 1: Write the failing test**

```ts
it('rethrows non-final failures so the queue retries', ...); // fire() must throw when attempts remain
it('gateway refuses over daily cap with 429', ...);
it('same messageLogId sent twice settles once (no double-send)', ...); // assert provider checks MessageLog status!=='PENDING' → no-op return existing providerMessageId
```

Last test pins Review Focus #1: before POSTing, `findFirst({id: messageLogId})` — if already `SENT`, return stored id without sending.
- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp/scheduled-message.service.spec.ts src/whatsapp/wa-gateway.provider.spec.ts` Expected: FAIL.
- [ ] **Step 3: Implement**

`fire()`: on catch, if attempts remain → `throw` (no status change, stays PENDING); only on final attempt mark FAILED. Cap check in gateway provider: count today's `waakg*` rows vs `WhatsappWebSession.dailyLimit ?? 200` → `TooManyRequestsException` over cap. Idempotency guard as tested.
- [ ] **Step 4: Run test to verify it passes**

Run: same specs. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/scheduled-message.service.ts src/whatsapp/scheduled-message.service.spec.ts src/whatsapp/wa-gateway.provider.ts src/whatsapp/wa-gateway.provider.spec.ts
git commit -m "fix: scheduled retries actually retry; gateway keeps daily cap and idempotent sends"
```

### Task 7: Gateway inbound webhook (signed, replay-safe)

**Files:**
- Create: `mygymagent-b/src/whatsapp/gateway-webhook.controller.ts` (`POST /whatsapp/gateway-inbound`)
- Create: `mygymagent-b/src/whatsapp/gateway-webhook.service.ts` (verify + map + file)
- Test: `mygymagent-b/src/whatsapp/gateway-webhook.spec.ts` (new).

**Interfaces:**
- Consumes: `WhatsappInboundFiler.file/fileGroup` (same ingress as socket path), `WA_GATEWAY_WEBHOOK_SECRET` (Task 2), WA-AKG payload `{event, sessionId, timestamp, data}` + `X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, raw body bytes)>`.
- Produces: `InboundMessage` rows + `whatsapp.received` event for `message.received`; MessageLog `DELIVERED/READ` advance for `message.status`; status cache update for `connection.update`. Registers in `whatsapp.module.ts` controllers.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects bad signature with 401 and writes nothing', ...);
it('rejects timestamps older than 5 minutes (replay)', ...);
it('message.received files an InboundMessage via the shared filer', ...);
it('message.status advances SENT→DELIVERED→READ, never backwards', ...);
it('unknown sessionId slug → 404, writes nothing', ...);
```

Use `timingSafeEqual` for compare; read raw body via `@Req() req: RawBodyRequest<Request>` (enable `rawBody` — check `main.ts` body-parser setup first; Nest default JSON parser consumes the stream, so this step includes wiring `rawBody: true` if absent).
- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp/gateway-webhook.spec.ts` Expected: FAIL.
- [ ] **Step 3: Implement**

Verify → resolve org from session slug (`gym-{orgId}` reverse-map; reject unknown) → switch on `event`. `message.received`: call `filer.file({organizationId, from: data.from digits, body: data.content, pushName, groupJid})` — identical downstream (member match, auto-reply listeners, CRM, outbound gym webhooks all fire unchanged). `message.status`: `updateMany({organizationId, providerMessageId: 'waakg-gw:'+keyId}, forward-only transition)`. `connection.update`: update `WaSession.status/lastError` (display only — socket no longer owned here).
- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp/gateway-webhook.spec.ts` Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/gateway-webhook.controller.ts src/whatsapp/gateway-webhook.service.ts src/whatsapp/gateway-webhook.spec.ts src/whatsapp/whatsapp.module.ts src/main.ts
git commit -m "feat: signed gateway inbound webhook with replay guard"
```

### Task 8: Pilot runbook + old-stack removal (last)

**Files:**
- Create: `mygymagent-b/docs/superpowers/plans/2026-10-11-waakg-cutover-runbook.md` (ops checklist, not code)
- Modify (only after zero orgs on old path): delete `src/whatsapp-web/wa-session.manager.ts`, `baileys-socket.factory.ts`, `wa-auth.store.ts`, `wa-sender.service.ts`, `wa-send.processor.ts`; unwrap factory to gateway-only; drop `baileys`, `qrcode`, `whatsapp-rust-bridge` deps.
- Test: full `npx jest src/whatsapp src/whatsapp-web src/communications src/automation` green + e2e `test:e2e:p1` on staging.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: single sending path; runbook with warmup schedule (20–30 msgs/day × 14 days), cap ladder (100 → 200 → 500 → 1000), ban-signal dashboard (401/403/LOGGED_OUT alerts), rollback (remove org from `WA_GATEWAY_ORG_IDS`).

- [ ] **Step 1: Write the runbook** (pilot org criteria, warmup table, monitor queries, rollback command).
- [ ] **Step 2: Pilot one gym**, watch 2 weeks, then widen `WA_GATEWAY_ORG_IDS` to `'*'`.
- [ ] **Step 3: Delete old stack + deps**, run full suite, commit as `feat!: remove in-process Baileys stack`.

---

## Self-Review

1. **Spec coverage:** every strategy point (provider swap, QR/status shape, inbound, caps, pilot, removal, gateway hardening) has a task. Warmup/caps/runbook → Task 8.
2. **Step scan:** each step names one artifact + one command + expected output. WA-AKG tasks use build+curl (no jest there — stated, not a gap).
3. **Type consistency:** `waakg-gw:<id>` prefix, `isGatewayOrg(config, orgId)`, `sessionIdFor(orgId)` reused, response shapes pinned to today's fields — consistent across Tasks 3–7.
4. **Review Focus:** all five have owning tests (Tasks 3, 4, 5, 6, 7 respectively).
5. **Proportion:** plan ≈ decisions only; bodies live with implementers.
