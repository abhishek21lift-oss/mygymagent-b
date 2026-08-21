# communications

**Status: EMAIL is real and provider-backed. WHATSAPP/SMS/PUSH are typed but not implemented.**

## What exists

- `CommunicationsService` — the single entry point for "send this kind of message to this person."
  Resolves a template (org override or system default), applies per-org branding, enforces
  MARKETING consent before a send is even attempted, logs the attempt to `MessageLog`, and
  dispatches to the channel's provider. See its class comment for the sync-vs-queued call shape.
- `SmtpEmailProvider` — real delivery over SMTP (`nodemailer`), configured via `SMTP_HOST` /
  `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM_ADDRESS`. Works with any
  SMTP-speaking mailbox or relay — Gmail/Workspace, a transactional-email provider's SMTP endpoint,
  a self-hosted relay — not a specific paid vendor's proprietary HTTP API. Unconfigured (no
  `SMTP_HOST`) means every send throws `ChannelNotConfiguredError`, caught by
  `CommunicationsService` and recorded as `MessageLog.status = 'FAILED'` — the same
  check-together-at-call-time pattern `FileStorageService` uses for S3, never a boot failure.
- `MessageTemplate` (`prisma/schema.prisma`) — one row per `(organizationId, key, channel)`. A null
  `organizationId` is a system default, seeded by `prisma/seed.ts` from
  `default-templates.catalog.ts`; an org can create its own override row for any key to customize
  wording (no API to create one yet — see "What's NOT here").
- `MessageLog` — the delivery-status/audit record for every send attempt: channel, category,
  template key, recipient, the member it was about (if any), status
  (`PENDING`/`SENT`/`FAILED`/`SKIPPED_NO_CONSENT`), attempt count, error message, timestamps.
- **Consent enforcement is real, not just recorded.** A `MARKETING`-category send to a member whose
  latest `MemberConsent(type: MARKETING)` isn't `granted: true` is never attempted — logged
  `SKIPPED_NO_CONSENT` instead. `TRANSACTIONAL` sends (password reset, welcome email, a membership
  renewal reminder about the member's own purchase) are never gated by marketing consent, the same
  distinction most email providers and regulations draw between "your receipt" and "our
  newsletter." This closes the gap the 2026-08-21 audit flagged: consent was fully modeled and
  recorded but nothing ever checked it before a send.
- **Per-org branding** — `Organization.emailFromName` / `.emailReplyTo`, applied to every email this
  service sends for that org. Falls back to the platform default sender identity
  (`SMTP_FROM_ADDRESS`) when unset.
- **Retries** — a send made from inside a BullMQ job (e.g. the welcome-email job, or a future
  automation-engine action) gets the queue's own retry/backoff for free (`queue.module.ts`'s
  `defaultJobOptions`: 3 attempts, exponential 5s) when `send()` throws. A synchronous,
  time-sensitive call (password reset) is not retried — matching the old `MailerService`'s
  fire-and-forget shape, except the failure is now visible in `MessageLog` instead of only a log
  line.

## What's NOT here

- **WhatsApp, SMS, push are unimplemented, not faked.** `WHATSAPP_PROVIDER`/`SMS_PROVIDER`/
  `PUSH_PROVIDER` are bound to `UnimplementedChannelProvider`, which always throws — a
  `MessageLog` row for one of these channels would be recorded `FAILED` with a clear "not connected"
  error, never silently dropped or pretended-sent. Building a real one needs: a provider SDK/API
  (e.g. Twilio for SMS, the WhatsApp Business API, FCM/APNs for push), real account credentials,
  and — for WhatsApp/SMS in particular — a webhook receiver for inbound delivery-status callbacks
  (`MessageLog.status` today is only ever set by the sending code itself, immediately; nothing
  updates a row later based on a provider's own async delivery/bounce/read receipt).
- **No template-management API.** `MessageTemplate` rows exist and are read by
  `MessageTemplateService.resolve()`; there's no `POST/PATCH /communications/templates` route yet
  for an org to create its own override — only the system defaults are seeded. `settings.manage`
  (RBAC catalog) is the natural permission key for this once it's built.
- **No campaigns/broadcast.** `send()` is always one message to one recipient. Bulk sending (e.g.
  "email every member with an expiring membership this week") is the automation engine's job
  (`src/automation/`) calling `send()` once per recipient, not a feature of this module.
- **HTML email.** Templates render to plain text only (`text`, no `html`, in `EmailMessage`) —
  `MessageTemplateService.render()`'s placeholder substitution has no HTML-escaping, so adding an
  HTML channel later needs that addressed first, not just a new template field.
- **No unsubscribe/opt-out link generation.** Consent is enforced by checking `MemberConsent`
  before a send; there's no self-service unsubscribe flow that writes a new consent row from a link
  click.
