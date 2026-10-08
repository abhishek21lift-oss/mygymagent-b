# P3 Segment Broadcast — Design (2026-10-08)

## 1. Intent
WA-AKG broadcast ka merge: segment chuno, abhi ya future me bhejo.
Locked: TRANSACTIONAL-only, consent-gated, pacing + daily-limit 200,
1 gym = 1 number. Scheduler one-shot + UI already exists; P3 sirf fan-out.

## 2. Architecture (approved)
`POST /whatsapp/broadcasts {segmentId, text, mediaKey?, sendAt?}` →
`BroadcastService` segment assignments se phones → `Broadcast` row →
per-member existing rasta (future: `wa-sched` delayed job; now: `wa-send`
paced job). Settle par `Broadcast` counters; detail `MessageLog.broadcastId`.
Naya queue/worker nahi. RBAC `whatsapp.manage` (create/cancel),
`whatsapp.read` (progress).

## 3. Components + DB (approved)
- `Broadcast` model: id, organizationId, segmentId, body, mediaFileId?,
  sendAt?, status PENDING|SENDING|DONE|CANCELLED, total/queued/sent/
  failed/skipped, createdByUserId, createdAt. `MessageLog.broadcastId?`.
- `b/src/whatsapp/broadcast.service.ts`: create (resolve+enqueue),
  progress, cancel (PENDING jobs remove).
- Controller: `POST /whatsapp/broadcasts`, `GET /whatsapp/broadcasts/:id`.
- Processors increment counters only when `broadcastId` present.
- Frontend `/broadcasts`: segment picker, text box, now/schedule,
  progress + skip reasons. `use-broadcasts.ts`.
- Out: cron/recurring, manual list, per-member preview.

## 4. Error handling + testing (approved)
- Empty/missing segment → 400/404 pre-enqueue. Unlinked mid-flight →
  jobs FAILED, broadcast DONE. Limit-hit member → failed counter, no retry.
  Cancel PENDING-only. Consent-skips counted with reason.
- Tests: unit (resolve/skip/cross-org) + e2e 4 (now, schedule, cancel,
  limit) + frontend hook/progress render + 3-member manual.
