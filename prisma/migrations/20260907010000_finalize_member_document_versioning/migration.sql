-- Finalize the MemberDocument -> MemberDocumentVersion migration.
-- The original member_documents table had a required fileId column. The
-- versioning model intentionally moved file ownership to
-- member_document_versions, but the legacy column was left in the physical
-- table. Backfill version 1 for existing documents before removing it.

INSERT INTO "member_document_versions" (
  "id",
  "organization_id",
  "document_id",
  "file_id",
  "version",
  "created_at"
)
SELECT
  gen_random_uuid(),
  md."organizationId",
  md."id",
  md."fileId",
  1,
  md."createdAt"
FROM "member_documents" md
WHERE md."fileId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "member_document_versions" mdv
    WHERE mdv."document_id" = md."id"
  );

-- The legacy FK/index/column are no longer part of the Prisma model.
ALTER TABLE "member_documents"
  DROP CONSTRAINT IF EXISTS "member_documents_fileId_fkey";

DROP INDEX IF EXISTS "member_documents_fileId_key";

ALTER TABLE "member_documents"
  DROP COLUMN IF EXISTS "fileId";
