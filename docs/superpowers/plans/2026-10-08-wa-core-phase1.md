# WA Core Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live Baileys session core inside `mygymagent-b`: per-gym sockets, Postgres auth keys, QR/pairing, status, and the send path.

**Architecture:** `src/whatsapp-web/` gains manager (socket lifecycle + Redis lock), Postgres auth store, sender + BullMQ `wa-send` queue with a holder-side processor, and a session facade; `WaAkgProvider.send()` delegates to the local sender, keeping `waakg:<id>` and the `MessageLog` flow.

**Tech Stack:** NestJS 11, Baileys `7.0.0-rc14`, Prisma 6 Postgres, BullMQ 6 + Redis, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-10-08-wa-core-phase1-design.md`

## Global Constraints

- Node >= 22 (`package.json` engines); Baileys pinned `7.0.0-rc14` (same version the deleted stack ran).
- `sessionId = gym-{organizationId}` verbatim; Redis lock `wa:socket:{orgId}`, 60s TTL, 20s renew.
- QR rotation overwrites `WaSession.qr`; 401/403 wipes keys + LOGGED_OUT + reason; 3 backoff reconnects then DISCONNECTED.
- Guards: MARKETING refused, per-gym daily cap 200/24h (1–1000 configurable), same 503/FAILED semantics as before.
- Reference: the deleted stack is the pattern source — read it via `git show <deletion-commit>^:src/whatsapp-web/<file>.ts` (manager, sender, auth-store, factory, processor). Copy patterns, not bugs; new names below win on conflict.
- Every task's requirements implicitly include this section.

## Review Focus

- WhatsApp rotates the QR mid-pairing → second QR overwrites the first; the settings card never shows a stale code.
- Socket 401s with sends queued → keys wiped, LOGGED_OUT, queued jobs fail LOUDLY with a relink error, never silently dropped.
- Two instances race one gym → exactly one socket (lock decide); the loser sends nothing.
- `connect` with `phoneNumber` returns an 8-char pairing code path, not just QR.
- Deploy mid-pairing → bootstrap resumes every non-LOGGED_OUT session; nothing stays PAIRING forever with no socket.

---
### Task 1: Schema + auth store

**Files:**
- Modify: `prisma/schema.prisma` (+`WaSession`, `WaAuthKey`, `WaSessionStatus` enum)
- Create: `src/whatsapp-web/wa-auth.store.ts`
- Create test: `src/whatsapp-web/wa-auth.store.spec.ts`
- Modify: `src/config/env.validation.ts` (+`WA_AUTH_KEY: z.string().optional()`)
- Modify: `.env.example` (+`WA_AUTH_KEY=""` + comment)

**Interfaces:**
- Consumes: `MFA_TOTP_KEY` pattern in `src/auth/mfa/mfa-secret.vault.ts` (envelope `v1.<iv>.<tag>.<cipher>`, AES-256-GCM, 12-byte iv) — same envelope, separate key.
- Produces: `WaAuthStore.read(sessionId: string, key: string) => Promise<string | null>`; `WaAuthStore.write(sessionId: string, key: string, value: string) => Promise<void>`; `WaAuthStore.clear(sessionId: string) => Promise<void>` (per-gym construction: `new WaAuthStore(prisma, sessionId, key: Buffer)`).

- [ ] **Step 1: Write the failing test**

```ts
it("round-trips a key through encrypted storage", async () => {
  const store = new WaAuthStore(prismaMock, "gym-o1", Buffer.alloc(32, 7))
  await store.write("creds", "secret-value")
  await expect(store.read("creds")).resolves.toBe("secret-value")
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp-web/wa-auth.store.spec.ts`
Expected: FAIL with "Cannot find module './wa-auth.store'"

- [ ] **Step 3: Implement migration + `WaAuthStore`** (parse key via 64-hex check, encrypt on write, decrypt on read, `deleteMany` on clear)

Run: `npx prisma migrate dev --name wa-session-core`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp-web/wa-auth.store.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/whatsapp-web/wa-auth.store.ts src/whatsapp-web/wa-auth.store.spec.ts src/config/env.validation.ts .env.example
git commit -m "feat(wacore): session schema and encrypted auth store"
```

### Task 2: Session manager

**Files:**
- Create: `src/whatsapp-web/wa-types.ts` (`WaSocketFactory` interface + minimal socket/message types for tests)
- Create: `src/whatsapp-web/wa-session.manager.ts`
- Create test: `src/whatsapp-web/wa-session.manager.spec.ts` (fake factory, no network)

**Interfaces:**
- Consumes: Task 1 `WaAuthStore`; Redis via existing queue connection (`src/queue/queue.module.ts` `QueueConnection` pattern from the deleted manager).
- Produces: `connect(sessionId, pairingPhone?) => Promise<{ qrDataUrl: string | null; pairingCode: string | null }>`; `disconnect(sessionId)`; `getStatus(sessionId) => "CONNECTED" | "PAIRING" | "DISCONNECTED" | "LOGGED_OUT"`; `sendNow(sessionId, jid, text) => Promise<string>` (Baileys key id; throws `NotOnWhatsapp`/`NotLinked` — re-create these two error classes in `wa-types.ts`); `codes(sessionId)` for QR/pairing reads.

- [ ] **Step 1: Write the failing test**

```ts
it("emits exactly one socket when two instances race", async () => {
  // two managers, same Redis, same session: only one factory.create call
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp-web/wa-session.manager.spec.ts`
Expected: FAIL with "Cannot find module './wa-session.manager'"

- [ ] **Step 3: Implement `WaSessionManager`** (lock acquire/renew/release, QR persist + overwrite on rotation, `loggedOut` wipe, 3-reconnect backoff, bootstrap resume of non-LOGGED_OUT rows, `OnApplicationShutdown` teardown)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp-web/wa-session.manager.spec.ts`
Expected: PASS (also pin: QR overwrite, 401 wipe + LOGGED_OUT, pairing-code path)

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp-web/wa-types.ts src/whatsapp-web/wa-session.manager.ts src/whatsapp-web/wa-session.manager.spec.ts
git commit -m "feat(wacore): session manager with Redis ownership"
```

### Task 3: Sender + queue + provider cutover

**Files:**
- Create: `src/whatsapp-web/wa-sender.service.ts`
- Create: `src/whatsapp-web/wa-send.processor.ts`
- Modify: `src/whatsapp-web/whatsapp-web.module.ts` (Bull queue `wa-send`, providers, remove HTTP-only wiring)
- Modify: `src/whatsapp/wa-akg.provider.ts` (delegate `send`/`ensureSession` to local sender+manager; keep `waakg:<id>`, JID, session map)
- Test: `src/whatsapp-web/wa-sender.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 manager (`sendNow`, `getStatus`); `MessageProvider.send` signature (unchanged).
- Produces: `WaSender.enqueue({organizationId, to(text, digits), text, category}) => Promise<string | {queued:true, providerMessageId:string}>` (MARKETING → throw; over daily cap → throw; unlinked → 503 naming relink).

- [ ] **Step 1: Write the failing test**

```ts
it("refuses MARKETING even with consent", async () => {
  await expect(sender.enqueue({ organizationId: "o1", to: "9198", text: "x", category: "MARKETING" })).rejects.toThrow(/marketing/i)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp-web/wa-sender.service.spec.ts`
Expected: FAIL with "Cannot find module './wa-sender.service'"

- [ ] **Step 3: Implement sender (guards + cap via `MessageLog` count + enqueue) + processor (`sendNow`, mark SENT via `providerMessageId`, failed jobs throw relink error)** + provider delegation

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/whatsapp-web/wa-sender.service.spec.ts src/whatsapp/wa-akg.provider.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp-web/wa-sender.service.ts src/whatsapp-web/wa-send.processor.ts src/whatsapp-web/whatsapp-web.module.ts src/whatsapp/wa-akg.provider.ts
git commit -m "feat(wacore): queued sender and provider cutover"
```

### Task 4: Facade rewire + gates

**Files:**
- Modify: `src/whatsapp-web/whatsapp-web.service.ts` (status/connect/disconnect/updateSettings via manager + `WaSession` rows; prefs stay in `WhatsappWebSession`)
- Modify: `src/whatsapp-web/whatsapp-web.service.spec.ts`, `src/whatsapp/wa-akg.provider.spec.ts` (fetch mocks → local doubles)
- Modify: `package.json` (+`baileys: 7.0.0-rc14`), `.env.example` (note)
- Test: re-add `test/whatsapp-web.e2e-spec.ts` (fake socket: pair → QR → connect → send → stays SENT), delete-able if it cannot pass without network

**Interfaces:**
- Consumes: Tasks 1–3 (manager, sender, `WaSession`).
- Produces: green gates; controller shapes unchanged (no frontend work).

- [ ] **Step 1: Rewrite the service spec to the manager double and watch it fail**

Run: `npx jest src/whatsapp-web/whatsapp-web.service.spec.ts`
Expected: FAIL (still mocks WA-AKG HTTP)

- [ ] **Step 2: Implement facade rewire + dep + e2e**

- [ ] **Step 3: Run gates**

Run: `npm run typecheck && npm run lint:ci && npx jest src/whatsapp src/whatsapp-web src/communications src/automation`
Expected: PASS (only the 3 known pre-existing lint failures elsewhere)

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(wacore): live session facade and gates"
```
