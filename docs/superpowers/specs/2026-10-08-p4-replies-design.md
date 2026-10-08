# P4 Staff Rules + Bot — Design (2026-10-08)

## 1. Intent
Staff apne keyword→jawab banaye (EXACT/CONTAINS/REGEX, 1:1 + groups) +
bot `#help`/`#stop`/`#start`. Gym intents fallback. Locked: safety
(pacing, limits), 1 gym = 1 number.

## 2. Architecture (approved)
Inbound do raste: 1:1 (existing file→event), group (participant
extraction → fileGroup → event with isGroup/groupJid). Ek
`StaffReplyListener`: bot-command → opt-out check → staff rules
(EXACT→CONTAINS→REGEX) → return (gym-intent fallback). Reply sendAdHoc
(`auto_reply.rule`/`auto_reply.bot`), recipient 1:1 sender / groupJid.
Rate-limit existing rows se shared (double-reply nahi).

## 3. Components + DB (approved)
- `AutoReplyRule` (keyword, matchType, scope ALL|PRIVATE|GROUP, answer,
  enabled, priority) + `BotOptOut` (org+phone unique). Migration ek.
- `WaMessageKey += participant/participantPn` + `groupSender()` helper.
- `onMessages` group branch → `filer.fileGroup()` (sender member-match reuse).
- `staff-reply.listener.ts` (+ pure matcher spec); gym listener untouched.
- Rules CRUD: naya `auto-replies.controller.ts`, `whatsapp.manage`.
- Frontend: Rules card in `/settings/whatsapp` + `use-auto-replies.ts`.
- Out: regex tester UI, import/export, per-rule stats.

## 4. Error handling + testing (approved)
- Invalid regex → skip + warn, chain alive; badge on save.
- Opt-out blocks all auto replies; group LID-only senders skip; reply
  sirf groupJid ko. Rule-vs-intent: single reply via MessageLog check.
- ReDoS noted, staff-written + 200-char cap; RE2 deferred.
- Tests: matcher unit + e2e 5 (1:1, group, stop/start, single-reply,
  invalid-regex) + frontend CRUD render.
