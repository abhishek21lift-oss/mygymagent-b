# WA-AKG merge into mygymagent-b/f — Design (2026-10-08)

## 1. Intent
Delete `WA-AKG/` repo. Its features move into `mygymagent-b` (NestJS) + `mygymagent-f` (Next.js).
Locked constraints: 1 gym = 1 number (`gym-{orgId}`), safety keep (MARKETING block, daily-limit 200 default, 8–15s pacing).

## 2. Phases
- P1 (this spec): rich-send image + reply-quote via existing `wa-send` queue.
- P2: inbox-chat send/reply UI.
- P3: broadcast via automation loop + one-shot scheduler UI.
- P4: generic autoreply CRUD + `#` bot commands.
- P5: groups/contacts/labels read-only sync.
- P6: webhooks fan-out + media-vault. `open-seo/` out of scope (zero overlap).

## 3. Architecture (P1) — approved
Reuse: `POST /whatsapp/messages` → `WhatsappService` → `CommunicationsService` (PENDING log)
→ `WaAkgProvider.send` → `WaSender.enqueue` → `wa-send` queue → `WaSendProcessor`
→ `WaSessionManager.sendNow` → Baileys `sendMessage`.
Only payload shape changes; no new gateway, no new queue.

## 4. Components (P1) — approved
- `b/src/whatsapp-web/wa-types.ts`: `WaSocket.sendMessage(jid, content)` union `{text}|{image+caption}`; `WaSendJob` += `mediaKey?`, `replyToMessageId?` (WhatsApp provider id being quoted).
- `b/src/whatsapp-web/wa-sender.service.ts`: accept mediaKey, same MARKETING/daily-limit checks.
- `b/src/whatsapp-web/wa-send.processor.ts`: fetch S3 via `FileStorageService`, call `manager.sendNow(org,to,content)`.
- `b/src/whatsapp-web/wa-session.manager.ts`: `sendNow` passthrough + `onWhatsApp` check.
- `b/src/whatsapp/dto/whatsapp.dto.ts`: `SendWhatsAppMessageDto` += `mediaKey?`, `replyToMessageId?`.
- `b/src/whatsapp/whatsapp.controller.ts`: no new route.
- DB: zero migration P1 (`MessageLog` + `File` reuse; mediaKey transient in job data).
- `f/src/lib/hooks/use-whatsapp.ts`, `settings/whatsapp/page.tsx`: TestSendCard file-picker (S3 upload → mediaKey).
- Explicitly NOT in P1: poll/location/contact/react/star, video/audio/document, broadcast, cron.

## 5. Error handling + testing (P1) — approved
- `NotLinkedError` → retry, last attempt FAILED; `NotOnWhatsappError` → immediate FAILED (`wa-send.processor.ts` unchanged logic).
- Invalid/missing S3 `mediaKey` → 400 at enqueue (org-scoped `File` check).
- MARKETING/over-limit → existing 403/429.
- Inbound image captions already read by `messageText()` → same filer path.
- Tests: unit (mediaKey passthrough, fake socket+S3 mock) + e2e 3 cases (image SENT, bad key 400, reply-To set) following `test/whatsapp-web.e2e-spec.ts`.
