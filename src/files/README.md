# files

**Status: the generic storage adapter is real; the only API surface over it lives in `members/`.**

## What exists

- `FileStorageService` (`file-storage.service.ts`) — a thin adapter over any S3-compatible object
  store (Cloudflare R2 in production, `s3rver` locally — see the repo README's "Object storage"
  setup section), per `docs/integrations/overview.md`'s "every external integration sits behind an
  adapter" rule. Three methods: `upload`, `getSignedUrl`, `delete`. Domain code never touches the
  S3 SDK, bucket name, or a raw key directly.
- `File` (`prisma/schema.prisma`) — the generic, tenant-scoped record of an object actually sitting
  in storage. Not files-module-owned data exclusively; any future attachment point (org logo,
  invoices, exercise media) reuses this table via its own join table, the same way `MemberDocument`
  does, rather than each domain inventing its own storage-tracking table.
- Registered globally (`FilesModule`, no controllers) so any module can inject
  `FileStorageService` without an explicit import — same pattern as `QueueModule` (`src/queue/`).

## What's NOT here

The only thing uploaded/downloaded today is **Member 360's Documents/Progress Photos**
(`src/members/member-documents.*`, `MemberDocumentCategory`: `DOCUMENT`/`PROGRESS_PHOTO`/
`ID_SCAN`/`OTHER` — progress photos are just a category on the same table, not a separate resource,
since they're the same shape: an uploaded file attached to a member). That endpoint is gated by
the same `members.read`/`members.read_assigned`/`members.update` permissions as the rest of Member
360, **not** a `files.*` permission — a generic `files.*` resource/standalone `/files` endpoint
doesn't exist and isn't needed until a non-member-scoped upload use case (org logo, invoices) shows
up, at which point it gets its own gating decision, not a retrofit of this one.

## Deliberate scope limits (read before extending this)

- **No image processing.** Uploads are stored as-is — no resizing, thumbnailing, or EXIF stripping.
  A progress photo's original file (potentially several MB, with embedded location metadata) is
  what gets stored and served.
- **No virus/malware scanning.** The MIME-type allowlist + size cap (`MemberDocumentsService`) stop
  the obvious abuse (arbitrary executables, oversized uploads) but do not inspect file *content* —
  a PDF or JPEG with an embedded exploit payload targeting a *viewer's* vulnerability isn't caught
  here.
- **Signed URLs, not a proxy.** `GET .../documents` returns a direct, time-limited S3 URL per file,
  not bytes streamed through this API. Fine for the current scale; means access-logging for "who
  actually downloaded this" is only as good as R2/S3's own access logs, not this app's.
- **No orphan-cleanup job.** `MemberDocumentsService.remove()` deletes the DB rows before the S3
  object, so a failure mid-delete can leave an orphaned S3 object with no DB row pointing at it
  (harmless — it just sits in the bucket, unreferenced) but nothing periodically sweeps those.
