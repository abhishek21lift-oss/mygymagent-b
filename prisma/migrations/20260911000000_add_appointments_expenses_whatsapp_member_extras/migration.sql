-- Appointments & trainer availability, expenses, WhatsApp integration,
-- member tags and member follow-ups.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lostReason" TEXT;

DO $$ BEGIN CREATE TYPE "AppointmentType" AS ENUM ('TRIAL', 'CONSULTATION', 'ASSESSMENT', 'FOLLOW_UP', 'PT_SESSION', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "appointments" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL, "staffId" TEXT, "memberId" TEXT, "leadId" TEXT,
  "type" "AppointmentType" NOT NULL, "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED', "title" TEXT NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL, "endTime" TIMESTAMP(3) NOT NULL, "notes" TEXT, "cancellationReason" TEXT,
  "clientName" TEXT, "clientEmail" TEXT, "clientPhone" TEXT, "remindersSent" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_time_check" CHECK ("endTime" > "startTime")
);
CREATE INDEX IF NOT EXISTS "appointments_organizationId_branchId_startTime_idx" ON "appointments"("organizationId", "branchId", "startTime");
CREATE INDEX IF NOT EXISTS "appointments_organizationId_staffId_startTime_idx" ON "appointments"("organizationId", "staffId", "startTime");
CREATE INDEX IF NOT EXISTS "appointments_organizationId_memberId_startTime_idx" ON "appointments"("organizationId", "memberId", "startTime");
CREATE INDEX IF NOT EXISTS "appointments_organizationId_leadId_startTime_idx" ON "appointments"("organizationId", "leadId", "startTime");
CREATE INDEX IF NOT EXISTS "appointments_organizationId_status_startTime_idx" ON "appointments"("organizationId", "status", "startTime");

DO $$ BEGIN CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "expenses" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "branchId" TEXT, "category" TEXT NOT NULL, "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD', "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING', "vendor" TEXT, "billNo" TEXT, "notes" TEXT,
  "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "paidAt" TIMESTAMP(3), "recordedByUserId" TEXT, "approvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expenses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "expenses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_amount_check" CHECK ("amount" > 0)
);
CREATE INDEX IF NOT EXISTS "expenses_organizationId_branchId_expenseDate_idx" ON "expenses"("organizationId", "branchId", "expenseDate");
CREATE INDEX IF NOT EXISTS "expenses_organizationId_category_expenseDate_idx" ON "expenses"("organizationId", "category", "expenseDate");
CREATE INDEX IF NOT EXISTS "expenses_organizationId_status_expenseDate_idx" ON "expenses"("organizationId", "status", "expenseDate");

DO $$ BEGIN CREATE TYPE "WhatsappIntegrationStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'DISCONNECTED', 'ERROR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "whatsapp_integrations" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "status" "WhatsappIntegrationStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
  "wabaId" TEXT, "phoneNumberId" TEXT, "displayPhoneNumber" TEXT, "displayName" TEXT, "businessAccountId" TEXT, "lastError" TEXT,
  "connectedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_integrations_pkey" PRIMARY KEY ("id"), CONSTRAINT "whatsapp_integrations_organizationId_key" UNIQUE ("organizationId"),
  CONSTRAINT "whatsapp_integrations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "member_tags" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "name" TEXT NOT NULL, "color" TEXT NOT NULL DEFAULT '#6366f1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "member_tags_pkey" PRIMARY KEY ("id"), CONSTRAINT "member_tags_organizationId_name_key" UNIQUE ("organizationId", "name"),
  CONSTRAINT "member_tags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "member_tags_organizationId_idx" ON "member_tags"("organizationId");

CREATE TABLE IF NOT EXISTS "member_tag_assignments" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "tagId" TEXT NOT NULL, "assignedByUserId" TEXT, "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_tag_assignments_pkey" PRIMARY KEY ("id"), CONSTRAINT "member_tag_assignments_memberId_tagId_key" UNIQUE ("memberId", "tagId")
);
CREATE INDEX IF NOT EXISTS "member_tag_assignments_organizationId_memberId_idx" ON "member_tag_assignments"("organizationId", "memberId");
CREATE INDEX IF NOT EXISTS "member_tag_assignments_tagId_idx" ON "member_tag_assignments"("tagId");

CREATE TABLE IF NOT EXISTS "member_follow_ups" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT, "dueAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "priority" TEXT NOT NULL DEFAULT 'MEDIUM', "createdByUserId" TEXT, "assignedToUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "member_follow_ups_pkey" PRIMARY KEY ("id"), CONSTRAINT "member_follow_ups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_follow_ups_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_follow_ups_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "member_follow_ups_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "member_follow_ups_organizationId_memberId_dueAt_idx" ON "member_follow_ups"("organizationId", "memberId", "dueAt");
CREATE INDEX IF NOT EXISTS "member_follow_ups_organizationId_memberId_completedAt_idx" ON "member_follow_ups"("organizationId", "memberId", "completedAt");

DO $$ BEGIN CREATE TYPE "MemberDocumentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "member_documents" ADD COLUMN IF NOT EXISTS "status" "MemberDocumentStatus" NOT NULL DEFAULT 'DRAFT', ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "reviewedByUserId" TEXT, ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT, ADD COLUMN IF NOT EXISTS "currentVersion" INTEGER NOT NULL DEFAULT 1;
DO $$ BEGIN ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "member_document_versions" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "documentId" TEXT NOT NULL, "version" INTEGER NOT NULL, "fileId" TEXT NOT NULL, "changeNotes" TEXT, "createdByUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_document_versions_pkey" PRIMARY KEY ("id"), CONSTRAINT "member_document_versions_documentId_version_key" UNIQUE ("documentId", "version"),
  CONSTRAINT "member_document_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "member_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_document_versions_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Production may already contain a legacy member_document_versions table created
-- before this migration. CREATE TABLE IF NOT EXISTS intentionally leaves that
-- table untouched, so bring the migration-required columns into alignment
-- before creating the documentId/version indexes and constraints.
ALTER TABLE "member_document_versions"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "documentId" TEXT,
  ADD COLUMN IF NOT EXISTS "version" INTEGER,
  ADD COLUMN IF NOT EXISTS "fileId" TEXT,
  ADD COLUMN IF NOT EXISTS "changeNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- If the legacy table is empty, the required NOT NULL invariants can be applied
-- safely. Non-empty legacy rows are not guessed or deleted; a later deployment
-- must reconcile those rows explicitly before enforcing NOT NULL/FKs.
DO $
DECLARE
  row_count BIGINT;
  null_required BIGINT;
BEGIN
  SELECT COUNT(*) INTO row_count FROM "member_document_versions";
  SELECT COUNT(*) INTO null_required
    FROM "member_document_versions"
   WHERE "organizationId" IS NULL
      OR "documentId" IS NULL
      OR "version" IS NULL
      OR "fileId" IS NULL;

  IF row_count = 0 THEN
    ALTER TABLE "member_document_versions"
      ALTER COLUMN "organizationId" SET NOT NULL,
      ALTER COLUMN "documentId" SET NOT NULL,
      ALTER COLUMN "version" SET NOT NULL,
      ALTER COLUMN "fileId" SET NOT NULL,
      ALTER COLUMN "createdAt" SET NOT NULL;
  ELSIF null_required > 0 THEN
    RAISE EXCEPTION 'Legacy member_document_versions contains % row(s) with missing required migration fields; refusing to guess or delete data', null_required;
  END IF;
END $;

DO $ BEGIN
  ALTER TABLE "member_document_versions"
    ADD CONSTRAINT "member_document_versions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $;
DO $ BEGIN
  ALTER TABLE "member_document_versions"
    ADD CONSTRAINT "member_document_versions_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "member_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $;
DO $ BEGIN
  ALTER TABLE "member_document_versions"
    ADD CONSTRAINT "member_document_versions_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $;

CREATE UNIQUE INDEX IF NOT EXISTS "member_document_versions_documentId_version_key" ON "member_document_versions"("documentId", "version");
CREATE INDEX IF NOT EXISTS "member_document_versions_documentId_version_idx" ON "member_document_versions"("documentId", "version");

DO $$ BEGIN CREATE TYPE "MemberDocumentCategory_new" AS ENUM ('DOCUMENT', 'PROGRESS_PHOTO', 'ID_SCAN', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "member_documents" ALTER COLUMN "category" TYPE "MemberDocumentCategory_new" USING "category"::text::"MemberDocumentCategory_new";
  ALTER TYPE "MemberDocumentCategory" RENAME TO "MemberDocumentCategory_old";
  ALTER TYPE "MemberDocumentCategory_new" RENAME TO "MemberDocumentCategory";
  DROP TYPE "MemberDocumentCategory_old";
EXCEPTION WHEN duplicate_object THEN NULL;
END $;
