# Integrations architecture (design only — not implemented)

## Principle
Every external integration sits behind an adapter interface defined by this codebase, never called
directly from domain services. A domain service depends on `NotificationSender` (an interface), not
on `TwilioClient` or `SendGridClient` directly — swapping providers, or supporting multiple
providers per organization, becomes a config change instead of a rewrite. This also gives the
`ai`/`billing`/`notifications` modules a stable seam to mock in tests, and keeps a compromised or
misbehaving third-party SDK from having a blast radius wider than its own adapter file.

## Planned integrations and their adapter interfaces

| Integration | Adapter interface (illustrative) | Notes |
|---|---|---|
| Email | `EmailSender.send({to, subject, body})` | `src/common/mailer/` already exists as a stub for this exact pattern — extend it, don't replace it. |
| WhatsApp | `WhatsAppSender.send({to, template, params})` | Template-based (WhatsApp Business API requires pre-approved templates) — the adapter should not accept arbitrary free-form message bodies. |
| Payment gateway | `PaymentProcessor.charge(...)`, `.refund(...)` | Needs to support at least one gateway with strong India-market coverage (Razorpay/similar) given the target market implied by the currency/locale defaults already in the schema (`Organization.currency` defaults `USD` but is per-org configurable). |
| Google Calendar | `CalendarSync.createEvent(...)` | For PT session scheduling once that domain exists. |
| Cloudflare R2 (or any S3-compatible store) | `FileStorage.upload(...)`, `.getSignedUrl(...)` | Backs the `files` module; the adapter interface should not leak provider-specific concepts (e.g. "bucket") into domain code — domain code asks for "store this member's profile photo," not "put this object in this bucket." |
| AI providers | Provider Adapter layer | Already specified in `docs/ai/architecture.md` — same pattern, applied first there since AI is the highest-risk integration. |
| Webhooks (outbound, e.g. notifying a customer's own systems) | `WebhookDispatcher.send(event, payload)` | Needs signing (HMAC) and retry-with-backoff from day one — an outbound webhook system without signature verification is a spoofing vector for whoever receives it. |
| Accounting software (e.g. QuickBooks/Zoho Books export) | `AccountingExporter.exportInvoices(...)` | Naturally layers on top of the billing separation in `docs/saas/billing-separation.md` — exports platform invoices and/or gym payments as two distinct export types, never merged. |
| Biometric/passkey auth | `PasskeyProvider` (WebAuthn) | Additive to the existing JWT/refresh-token auth (ADR 0002), not a replacement — a passkey registration would still result in the same session-issuance flow. |

## What "isolated behind an adapter" means concretely
1. The interface lives in the owning domain module (e.g. `src/notifications/whatsapp-sender.interface.ts`), not in a generic `integrations/` grab-bag — a WhatsApp sender belongs conceptually to notifications, not to "integrations" as its own domain.
2. Provider-specific config (API keys, webhook secrets) is read once, in the adapter's implementation class, from environment variables documented in `.env.example` — never scattered across call sites.
3. A test double implementing the same interface is used in tests; no test should require real network access to a third-party API.
4. Failure handling (timeout, 5xx from the provider, rate limit from the provider) is the adapter's responsibility to normalize into a small set of typed outcomes the domain service can react to sensibly (retry vs. fail vs. queue-for-later) — a domain service should never need to know that "WhatsApp returned a 429" specifically.

## Not built yet
None of the adapters or their concrete implementations exist — `notifications`, `files` are module
skeletons (`README.md` + empty `Module` class). This document exists so the first integration built
follows one consistent shape instead of each integration inventing its own pattern.
