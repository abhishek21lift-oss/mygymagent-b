# Import / export architecture (design only — not implemented)

## Scope
CSV member import, CSV export (members, attendance), financial exports, and general data
portability (a tenant getting their own data out, independent of any support/compliance request).

## Export

Straightforward relative to import: a tenant-scoped query, streamed to CSV, never loaded fully into
memory for large result sets (attendance/financial history can run into the millions of rows at the
scale target in `docs/testing/strategy.md`). Proposed shape:

```
POST /exports              -> creates an ExportJob (async), returns job id
GET  /exports/:id          -> job status: queued | processing | complete | failed
GET  /exports/:id/download -> signed URL once complete (file lives in object storage briefly, not returned inline)
```

Synchronous CSV generation is fine for small orgs' member lists; anything attendance/financial-
history-sized goes through the same background-job path as large imports (see below) rather than
holding an HTTP request open.

## Import (CSV member import)

**Must validate before committing, in full, before any row is written** — a partially-applied
import that fails halfway through is worse than one that fails before writing anything, because it
leaves the org's data in an inconsistent, hard-to-diagnose state.

Proposed flow:
```
1. Upload CSV -> stored temporarily, not parsed synchronously in the request
2. Parse + validate ALL rows against MemberImportRowSchema (duplicate memberCode within the file,
   invalid email format, missing required fields, referenced branch/plan doesn't exist in this org, ...)
3. Return a validation report: N valid rows, M invalid rows with specific per-row errors
4. User reviews the report, confirms (or fixes and re-uploads)
5. Only on explicit confirm: background job processes the validated rows as a single DB transaction
   per batch (not one giant transaction for 50,000 rows, which would hold locks too long — batched,
   e.g. 500 rows per transaction, with the job tracking how many batches committed so a failure
   partway through is resumable/reportable, not silently half-applied)
6. Job completion produces an import report: created N, skipped M (already existed, matched by
   memberCode), failed K (with reasons) — never a bare "done"
```

## Background jobs

Both large imports and large exports need an actual job queue — **this infrastructure now exists**
(`src/queue/`, BullMQ + Redis, see `docs/ARCHITECTURE.md` §10.5), built as its own phase rather than
improvised inline (the queue's first real job is a welcome email, not import/export — see
`src/notifications/README.md`). Building the import/export flow above is now "register a queue +
processor following the existing pattern," not "stand up job infrastructure from scratch."

## What's exposed today
Still nothing — no import or export endpoint exists in any module. The queue infrastructure this
design depends on is built; the import/export feature itself is not. This document remains the
shape to build against once prioritized.
