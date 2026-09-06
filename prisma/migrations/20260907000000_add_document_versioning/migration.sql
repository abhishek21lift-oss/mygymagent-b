-- Ensure MemberDocumentStatus enum exists
DO $$
BEGIN
  CREATE TYPE "MemberDocumentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add status column only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_documents'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE "member_documents" ADD COLUMN "status" VARCHAR(50) NOT NULL DEFAULT 'DRAFT';
  END IF;
END $$;

-- Add submitted_at column only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_documents'
      AND column_name = 'submitted_at'
  ) THEN
    ALTER TABLE "member_documents" ADD COLUMN "submitted_at" TIMESTAMP;
  END IF;
END $$;

-- Add reviewed_at column only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_documents'
      AND column_name = 'reviewed_at'
  ) THEN
    ALTER TABLE "member_documents" ADD COLUMN "reviewed_at" TIMESTAMP;
  END IF;
END $$;

-- Add reviewed_by_user_id column only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_documents'
      AND column_name = 'reviewed_by_user_id'
  ) THEN
    ALTER TABLE "member_documents" ADD COLUMN "reviewed_by_user_id" TEXT;
  END IF;
END $$;

-- Add rejection_reason column only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_documents'
      AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE "member_documents" ADD COLUMN "rejection_reason" TEXT;
  END IF;
END $$;

-- Add FK constraint only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_member_documents_reviewed_by_user'
  ) THEN
    ALTER TABLE "member_documents"
      ADD CONSTRAINT "fk_member_documents_reviewed_by_user"
      FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Create member_document_versions table only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'member_document_versions'
  ) THEN
    CREATE TABLE "member_document_versions" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "organization_id" TEXT NOT NULL,
      "document_id" TEXT NOT NULL,
      "file_id" TEXT NOT NULL UNIQUE,
      "version" INTEGER NOT NULL,
      "change_notes" TEXT,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),

      CONSTRAINT "fk_member_document_versions_document"
        FOREIGN KEY ("document_id") REFERENCES "member_documents"("id") ON DELETE CASCADE,
      CONSTRAINT "fk_member_document_versions_file"
        FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE,
      CONSTRAINT "fk_member_document_versions_organization"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
    );
  END IF;
END $$;

-- Create indexes only if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_member_document_versions_document_version'
  ) THEN
    CREATE UNIQUE INDEX "uq_member_document_versions_document_version"
      ON "member_document_versions"("document_id", "version");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_member_document_versions_org_doc'
  ) THEN
    CREATE INDEX "idx_member_document_versions_org_doc"
      ON "member_document_versions"("organization_id", "document_id");
  END IF;
END $$;
