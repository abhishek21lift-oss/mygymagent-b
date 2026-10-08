# WA Core Phase 1 Design (in-process sessions) — 2026-10-08

## Intent (agreed)
Port WA-AKG into `mygymagent-b`, phased. Phase 1 = live Baileys session
core inside the backend: session manager, Postgres auth store, QR/pairing,
status, and the send path. Replaces the external-gateway client merged
earlier and the old `src/whatsapp-web/` Baileys stack (already deleted).

Assumptions: one shared deployment, one session per gym
(`sessionId = gym-{organizationId}`); backend JWT + RBAC only (no WA-AKG
user/key system); new Postgres tables (no shared MySQL); prefs stay in
`WhatsappWebSession`.

## Approaches considered
- **A — Phased in-place port (chosen):** P1 sessions, P2 inbound/media +
  webhooks, P3 scheduler + auto-reply on BullMQ, P4 groups/contacts. Each
  phase ships behind the current facade. Cut: dashboard UI, n8n, labels.
- B — Big-bang port: rejected (long dark period, biggest review).
- C — Owned microservice: rejected (another deployment ≈ today's gateway
  ops shape, just owned code).

## §1 Modules + tables
- `src/whatsapp-web/`: `wa-session.manager.ts` (one socket per gym,
  Redis lock ownership), `wa-auth.store.ts` (keys in Postgres,
  AES-256-GCM via new `WA_AUTH_KEY`), `wa-sender.service.ts`
  (text/media, returns key id), `wa-session.service.ts` (facade;
  controller unchanged).
- Migration: `WaSession(organizationId unique, sessionId unique, status,
  qr, phoneNumber, pairingCode, lastError, connectedAt)` +
  `WaAuthKey(sessionId, key, valueEnc)` (`@@unique[sessionId, key]`).
- `WaAkgProvider.send()` delegates to the local sender; `waakg:<id>`
  prefix and `MessageLog` flow unchanged. Deps: `baileys` pinned back (`7.0.0-rc14`,
the version the deleted stack ran).
- Out: P2 inbound, P3 scheduler/auto-reply, P4 groups/contacts,
  dashboard/labels/n8n.

## §2 Lifecycle + send flow
- `connect()`: upsert `WaSession(PAIRING)` + risk row → socket with
  `WaAuthStore` → QR persisted to `WaSession.qr` → `open` = CONNECTED +
  phoneNumber, QR cleared → `loggedOut` wipes keys + reason → 3 backoff
  reconnects then DISCONNECTED. `disconnect()` = logout + wipe +
  DISCONNECTED.
- Multi-instance: Redis lock `wa:socket:{orgId}` (60s TTL, 20s renew);
  only the holder sockets. Sends via BullMQ `wa-send` queue; single
  instance works with zero config.
- Send: normalize JID (unchanged) → enqueue → holder sends →
  `waakg:<key.id>` → SENT row. Receipts land in P2; P1 rows stay SENT.
- Guards ported: MARKETING refused, per-gym daily cap (same constants,
  same 503/FAILED semantics).

## §3 Errors, testing, rollout
- 401/403 → wipe + LOGGED_OUT + reason, sending off. Connect with live
  session → Conflict. Missing `WA_AUTH_KEY` → 503 naming it. No silent
  fallback: dropped sockets produce FAILED rows that say relink.
- Unit: JID/map, auth encrypt round-trip, cap/refusal, lock acquire/expire.
  E2E: fake-socket pair → QR → connect → send → stays-SENT. Migration
  check: `prisma migrate diff` empty after apply.
- Ships behind the facade (frontend untouched) → one staging gym on a
  spare number → QR→CONNECTED→send→disconnect→relink → P2 spec.
  External-gateway path deleted at P1 go-live.
