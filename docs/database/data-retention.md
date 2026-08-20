# Data retention policy

## Principle

A "delete" button in the UI must never mean "row disappears from the database" for anything with
financial, legal, or audit significance. It means the record is marked cancelled/inactive/soft-
deleted, stays queryable by anyone with the right permission, and is excluded from default
listings.

## Per-category policy

### Audit logs (`AuditLog`)
- **Never deleted, ever**, by application code — no endpoint, no cron job, no admin action performs
  a hard delete. `organizationId` and `actorUserId` use `onDelete: SetNull` specifically so
  deleting an organization or user does not cascade-delete the audit trail of what they did.
- Retention is indefinite by default. If a jurisdiction's compliance requirement eventually caps
  audit log retention (some data-protection regimes do), that becomes an explicit, documented
  archival job (cold-storage export + delete-after-archive), not a silent cron job — needs a
  product decision on the retention window per region before it's built.

### Financial records (`Membership` today; payment/invoice tables once billing is built)
- Cancellation/refund is a **status change** (`Membership.status = CANCELLED`), never a row
  deletion. `Membership.price` is already snapshotted at purchase time so it never drifts even if
  the originating plan is later edited or deactivated.
- When the payments/billing domain is built, the same rule applies to `Payment`/`Invoice`/
  `Refund` rows: a refund creates a new linked row, it does not mutate or delete the original
  charge.

### Deleted members / users (`Member.deletedAt`, `User.deletedAt`)
- Soft-delete only. The row and its `deletedAt` timestamp persist; the application filters
  `deletedAt: null` in default queries. `Membership` and `Attendance` rows referencing a
  soft-deleted `Member` are untouched — a member's history doesn't disappear because their profile
  was archived.
- A **hard-delete/purge path** for GDPR-style "right to erasure" requests is not implemented yet.
  When built, it must NOT touch `AuditLog` or financial rows (those are legally the reason erasure
  requests have carve-outs in most regimes) — it would anonymize the `Member`/`User` PII fields
  (name, email, phone, address) in place while leaving the row, its id, and its financial/audit
  history intact. This needs explicit legal/product sign-off on scope before being built, not an
  engineering default.

### AI conversations
- Not applicable yet — no AI conversation history is persisted (the `ai` module is design-only, see
  `docs/ai/architecture.md`). When built: conversation transcripts are tenant-scoped, should NOT be
  used as model training data without explicit per-organization opt-in, and get the same soft-delete
  treatment as other org data — a user clearing their chat history hides it from them, it doesn't
  destroy an org admin's ability to audit what the AI was asked/told to do.

### Uploaded files
- Not applicable yet — no file storage integration exists (`files` module is a skeleton). When
  built (see `docs/integrations/overview.md`'s storage adapter), deletion follows the same
  soft-delete-then-archive pattern: mark deleted immediately (stop serving it), physically purge
  from object storage only after a grace period, not synchronously on delete.

### Sessions / tokens (`RefreshToken`, `PasswordResetToken`, `EmailVerificationToken`)
- These are security artifacts, not business records — `revokedAt`/`usedAt`/`expiresAt` mark them
  dead. Rows are kept (not hard-deleted) for a bounded window for forensic purposes (detecting
  reuse of a revoked/rotated token, which the auth flow already treats as a compromise signal), then
  are safe to purge via a periodic cleanup job once well past `expiresAt` — this job does not exist
  yet and should be added alongside the first real deployment's scheduled-job infrastructure.

## What's implemented today vs. designed only

| Category | Status |
|---|---|
| Org/branch/user/member soft-delete (`deletedAt`) | Implemented |
| Audit log immutability (no update/delete code path) | Implemented |
| Membership financial-record immutability (price snapshot, status-based cancellation) | Implemented |
| Expired-token cleanup job | Not implemented — needs scheduled-job infra first |
| GDPR-style PII erasure/anonymization path | Not implemented — needs product/legal scope decision |
| AI conversation retention | Not applicable — AI module not built |
| File retention | Not applicable — file storage not integrated |
