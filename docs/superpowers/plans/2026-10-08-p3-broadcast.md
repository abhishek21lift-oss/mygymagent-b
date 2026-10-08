# P3 Segment Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff picks a member segment, sends now or schedules, watches progress.

**Architecture:** `BroadcastService` resolves segment phones, fans out one job per member over the existing `wa-send` (now) / `wa-scheduled` (future) queues; processors increment `Broadcast` counters when `broadcastId` rides along. No new queue, no new worker.

**Tech Stack:** NestJS 11, Prisma 6, BullMQ 6, Next.js 16 + TanStack Query v5 + RTL/Jest.

**Spec:** `docs/superpowers/specs/2026-10-08-p3-broadcast-design.md` (in `mygymagent-b`)

## Global Constraints

- TRANSACTIONAL-only broadcasts; per-recipient consent/phone/daily-limit/pacing unchanged.
- 1 gym = 1 number (`gym-{orgId}`); no multi-session.
- RBAC: create/cancel needs `whatsapp.manage`, progress needs `whatsapp.read`.
- No `--forceExit` in e2e; every spec keeps `afterAll: prisma.$disconnect + app.close`.
- Out of scope: cron/recurring, manual number lists, per-member preview.

## Review Focus

- A `segmentId` from another gym → 404, zero jobs enqueued.
- A segment with zero emailable members → 400 before any row/job.
- A member with no phone → counted `skipped` with reason, never queued.
- `sendAt` in the past → 400 (past means now; caller retries as send-now).
- Cancelling a DONE broadcast → 404, counters frozen.

---
### Task 1: Broadcast tables

**Files:**
- Modify: `mygymagent-b/prisma/schema.prisma` (new `Broadcast`, `MessageLog.broadcastId?`)
- Create: `mygymagent-b/prisma/migrations/<ts>_broadcast/migration.sql`
- Test: `mygymagent-b` drift-check script

**Interfaces:**
- Consumes: nothing.
- Produces: `Broadcast { id, organizationId, segmentId, body, mediaFileId?, sendAt?, status, total, queued, sent, failed, skipped, createdByUserId, createdAt }`, `BroadcastStatus = PENDING|SENDING|DONE|CANCELLED`; `MessageLog.broadcastId String?` (+index).

- [ ] **Step 1: Add the models to `prisma/schema.prisma`**

`Broadcast` with `@@map("broadcasts")`, `@@index([organizationId, status])`; `MessageLog` gains `broadcastId String?`, `broadcast Broadcast? @relation(fields: [broadcastId], references: [id], onDelete: SetNull)`, `@@index([broadcastId])`.

- [ ] **Step 2: Hand-author the migration SQL**

Same shape as `20261008200000_message_log_body/migration.sql`: `CREATE TABLE "broadcasts" (...)` + `ALTER TABLE "message_logs" ADD COLUMN "broadcastId" TEXT;`. (No dev DB here — see P2 Task 1 ruling.)

- [ ] **Step 3: Verify no drift**

Run: `node scripts/check-schema-drift.cjs` (with `SHADOW_DATABASE_URL` set, as in P2)
Expected: `migrations and schema.prisma agree`

- [ ] **Step 4: Apply to test DB**

Run: `npx dotenv -e .env.test -- npx prisma migrate deploy`
Expected: `All migrations have been successfully applied`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(broadcast): broadcast tables"
```

### Task 2: Audience resolve + BroadcastService

**Files:**
- Modify: `mygymagent-b/src/member-intelligence/segments.service.ts` (+ `getSegmentPhones`)
- Create: `mygymagent-b/src/whatsapp/broadcast.service.ts`
- Create test: `mygymagent-b/src/whatsapp/broadcast.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 tables; `WaSender.enqueue` (P1 shape), `ScheduledMessageService.schedule`-equivalent delayed enqueue; `toJid` (P1 provider).
- Produces: `SegmentsService.getSegmentPhones(orgId, segmentId): Promise<{ memberId, phone }[]>` (throws 404 cross-org/missing); `BroadcastService.create(orgId, userId, { segmentId, text, mediaKey?, sendAt? })`, `.progress(orgId, id)`, `.cancel(orgId, id)`.

- [ ] **Step 1: Write the failing test**

```ts
it("skips members without phones and counts them", async () => {
  // phones: [{ memberId: "m1", phone: "+9198" }, { memberId: "m2", phone: null }]
  const out = await svc.create("o1", "u1", { segmentId: "s1", text: "Hi" })
  expect(out.skipped).toBe(1); expect(out.total).toBe(1)
})
it("rejects a foreign segment with 404 and enqueues nothing", ...)
it("rejects an empty audience with 400 and leaves no row", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/whatsapp/broadcast.service.spec.ts` (in `mygymagent-b`)
Expected: FAIL with "Cannot find module './broadcast.service'"

- [ ] **Step 3: Implement `getSegmentPhones` in `segments.service.ts`**

Reuse private `resolveSegmentMembers`, then map to phones via `prisma.member.findMany({ where: { id: { in } }, select: { id, phone } })`; segment lookup is org-scoped, missing → `NotFoundException`.

- [ ] **Step 4: Implement `BroadcastService` in `src/whatsapp/broadcast.service.ts`**

Create `Broadcast` row PENDING; empty audience → 400 (no row left behind — delete it); phone-less → `skipped++`; mediaKey validated by P1 `assertSendableImage`-equivalent (reuse via `WhatsappService`? No — call the same private logic; smallest move: broadcast validates through `prisma.file` check duplicated in 5 lines with the same messages); now → `WaSender.enqueue` per member with `broadcastId` (`WaSendJob += broadcastId?: string` in `wa-sender.service.ts`); future `sendAt` → delayed `wa-sched`-style job carrying `broadcastId` (reuse `ScheduledMessageService` row? No — broadcast items are not staff-composed singles; enqueue a BullMQ delayed job on `WA_SCHEDULED` with `{ broadcastId, memberId, to, text }` and handle it in the existing scheduled processor by `broadcastId`); `progress` returns row + per-status `MessageLog` counts; `cancel` removes PENDING jobs, CANCELLED, DONE → 404.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/whatsapp/broadcast.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp/broadcast.service.spec.ts src/whatsapp/broadcast.service.ts src/member-intelligence/segments.service.ts
git commit -m "feat(broadcast): segment fan-out service"
```

### Task 3: Routes + counters + e2e

**Files:**
- Modify: `mygymagent-b/src/whatsapp/whatsapp.controller.ts` (+2 routes)
- Modify: `mygymagent-b/src/whatsapp/whatsapp.module.ts` (provide service)
- Modify: `mygymagent-b/src/whatsapp-web/wa-send.processor.ts`, `mygymagent-b/src/whatsapp/scheduled-message.processor.ts` (counter increments)
- Test: `mygymagent-b/test/whatsapp-broadcast.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2 service.
- Produces: `POST /whatsapp/broadcasts` (201, `whatsapp.manage`, audited), `GET /whatsapp/broadcasts/:id` (`whatsapp.read`).

- [ ] **Step 1: Write the failing e2e** — 5 cases: (a) 3-member segment send-now → DONE + SENT rows with `broadcastId`; (b) future `sendAt` → PENDING + zero SENT; (c) cancel → CANCELLED, then cancel-again → 404; (d) member over daily limit → failed counter; (e) past `sendAt` → 400. (Fake socket pattern from `test/whatsapp-p1-media.e2e-spec.ts`; segment = system segment seeded via API or direct `memberSegment` row + rules matching test members.)

- [ ] **Step 2: Run to verify fail**

Run: `REDIS_URL=redis://localhost:56379 npx dotenv -e .env.test -- npx jest --config ./test/jest-e2e.json --runInBand test/whatsapp-broadcast.e2e-spec.ts` (s3rver on :4568)
Expected: FAIL (404, no routes)

- [ ] **Step 3: Implement routes + counter hooks**

Counters increment in both processors only when `job.data.broadcastId` is set (`sent/failed`); `DONE` when `sent+failed+skipped === total` (checked after each increment; race-safe enough at gym scale — single `wa-send` concurrency 1 per gym plus atomic `updateMany` guard on expected status).

- [ ] **Step 4: Run e2e to verify pass**

Same command as Step 2. Expected: PASS (5/5).

- [ ] **Step 5: Run P1 slice for regressions**

Run: `npm run test:e2e:p1`
Expected: PASS, clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp/ src/whatsapp-web/wa-send.processor.ts test/whatsapp-broadcast.e2e-spec.ts
git commit -m "feat(broadcast): routes, counters, e2e"
```

### Task 4: Broadcasts page (frontend, in `mygymagent-f`)

**Files:**
- Create: `src/lib/hooks/use-broadcasts.ts` (+ test `use-broadcasts.test.ts`)
- Create: `src/app/(app)/broadcasts/page.tsx` (+ test)
- Modify: `src/lib/nav-config.ts` (Engage += Inbox-style entry, `whatsapp.manage`)

**Interfaces:**
- Consumes: Task 3 routes; existing `useSegments` picker data (`/members/segments`).
- Produces: page with segment select, text box, now/schedule toggle, progress bar + skip reasons.

- [ ] **Step 1: Write failing hook test** — create posts `{ segmentId, text, sendAt? }`, progress polls `GET` (10s, background off — same `conversationPolling` shape as inbox).

- [ ] **Step 2: Run to verify fail** — `npx jest src/lib/hooks/use-broadcasts.test.ts`, FAIL module missing.

- [ ] **Step 3: Implement hook + page** — segment select from `useSegments`, recipient-count preview via existing segment members endpoint, composer disabled without `whatsapp.manage`, progress bar from counters, skip list.

- [ ] **Step 4: Page test** — gate (no `whatsapp.read` → ErrorState), DONE broadcast shows 100%.

- [ ] **Step 5: Run typecheck + lint + new tests** — `npm run typecheck`, `npx jest src/lib/hooks/use-broadcasts src/app/\(app\)/broadcasts`, `npm run lint` (0 errors).

- [ ] **Step 6: Commit** — `git commit -m "feat(broadcast): broadcasts page and progress"`.
