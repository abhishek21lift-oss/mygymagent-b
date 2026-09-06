-- Align the physical timestamp column with Prisma's MemberDocumentVersion.createdAt.
-- The initial versioning migration created snake_case `created_at`, while the
-- Prisma model uses the default camelCase column name `createdAt`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_document_versions'
      AND column_name = 'created_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_document_versions'
      AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "member_document_versions"
      RENAME COLUMN "created_at" TO "createdAt";
  END IF;
END $$;

ALTER TABLE "member_document_versions"
  ALTER COLUMN "createdAt" SET DEFAULT now();
