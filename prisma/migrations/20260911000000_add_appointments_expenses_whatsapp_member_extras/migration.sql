-- Appointments & trainer availability, expenses, WhatsApp integration,
-- member tags and member follow-ups. Completes the gym operating surface
-- the frontend calendar / finance / settings / Member 360 screens already
-- render against (previously 404ing with no backend tables).

-- Lost-reason capture for LOST leads (required by the frontend lost-lead
-- flow and GET /analytics/sales/lost-reasons).
ALTER TABLE "leads" ADD COLUMN "lostReason" TEXT;

CREATE TYPE "AppointmentType" AS ENUM ('TRIAL', 'CONSULTATION', 'ASSESSMENT', 'FOLLOW_UP', 'PT_SESSION', 'OTHER');
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');

CREATE TABLE "appointments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "staffId" TEXT,
  "memberId" TEXT,
  "leadId" TEXT,
  "type" "AppointmentType" NOT NULL,
  "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
  "title" TEXT NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL,
  "endTime" TIMESTAMP(3) NOT NULL,
  "notes" TEXT,
  "cancellationReason" TEXT,
  "clientName" TEXT,
  "clientEmail" TEXT,
  "clientPhone" TEXT,
  "remindersSent" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_time_check" CHECK ("endTime" > "startTime")
);
CREATE INDEX "appointments_organizationId_branchId_startTime_idx" ON "appointments"("organizationId", "branchId", "startTime");
CREATE INDEX "appointments_organizationId_staffId_startTime_idx" ON "appointments"("organizationId", "staffId", "startTime");
CREATE INDEX "appointments_organizationId_memberId_startTime_idx" ON "appointments"("organizationId", "memberId", "startTime");
CREATE INDEX "appointments_organizationId_leadId_startTime_idx" ON "appointments"("organizationId", "leadId", "startTime");
CREATE INDEX "appointments_organizationId_status_startTime_idx" ON "appointments"("organizationId", "status", "startTime");

CREATE TABLE "trainer_availability_rules" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "branchId" TEXT,
  "dayOfWeek" INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "endMinute" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trainer_availability_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trainer_availability_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_availability_rules_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_availability_rules_day_check" CHECK ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6),
  CONSTRAINT "trainer_availability_rules_minutes_check" CHECK ("startMinute" >= 0 AND "startMinute" < "endMinute" AND "endMinute" <= 1440)
);
CREATE INDEX "trainer_availability_rules_organizationId_staffId_dayOfWeek_idx" ON "trainer_availability_rules"("organizationId", "staffId", "dayOfWeek");

CREATE TABLE "trainer_time_offs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "branchId" TEXT,
  "reason" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trainer_time_offs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trainer_time_offs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_time_offs_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_time_offs_time_check" CHECK ("endAt" > "startAt")
);
CREATE INDEX "trainer_time_offs_organizationId_staffId_startAt_idx" ON "trainer_time_offs"("organizationId", "staffId", "startAt");

CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

CREATE TABLE "expenses" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "category" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING',
  "vendor" TEXT,
  "billNo" TEXT,
  "notes" TEXT,
  "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "recordedByUserId" TEXT,
  "approvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expenses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "expenses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expenses_amount_check" CHECK ("amount" > 0)
);
CREATE INDEX "expenses_organizationId_branchId_expenseDate_idx" ON "expenses"("organizationId", "branchId", "expenseDate");
CREATE INDEX "expenses_organizationId_category_expenseDate_idx" ON "expenses"("organizationId", "category", "expenseDate");
CREATE INDEX "expenses_organizationId_status_expenseDate_idx" ON "expenses"("organizationId", "status", "expenseDate");

CREATE TYPE "WhatsappIntegrationStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'DISCONNECTED', 'ERROR');

CREATE TABLE "whatsapp_integrations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "status" "WhatsappIntegrationStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
  "wabaId" TEXT,
  "phoneNumberId" TEXT,
  "displayPhoneNumber" TEXT,
  "displayName" TEXT,
  "businessAccountId" TEXT,
  "lastError" TEXT,
  "connectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_integrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_integrations_organizationId_key" UNIQUE ("organizationId"),
  CONSTRAINT "whatsapp_integrations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "member_tags" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#6366f1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "member_tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_tags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_tags_organizationId_name_key" UNIQUE ("organizationId", "name")
);
CREATE INDEX "member_tags_organizationId_idx" ON "member_tags"("organizationId");

CREATE TABLE "member_tag_assignments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  "assignedByUserId" TEXT,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_tag_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_tag_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_tag_assignments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "member_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_tag_assignments_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "member_tag_assignments_memberId_tagId_key" UNIQUE ("memberId", "tagId")
);
CREATE INDEX "member_tag_assignments_organizationId_memberId_idx" ON "member_tag_assignments"("organizationId", "memberId");
CREATE INDEX "member_tag_assignments_tagId_idx" ON "member_tag_assignments"("tagId");

CREATE TABLE "member_follow_ups" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "dueAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
  "createdByUserId" TEXT,
  "assignedToUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "member_follow_ups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_follow_ups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_follow_ups_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_follow_ups_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "member_follow_ups_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "member_follow_ups_organizationId_memberId_dueAt_idx" ON "member_follow_ups"("organizationId", "memberId", "dueAt");
CREATE INDEX "member_follow_ups_organizationId_memberId_completedAt_idx" ON "member_follow_ups"("organizationId", "memberId", "completedAt");

-- Member document review workflow (DRAFT -> SUBMITTED -> APPROVED /
-- REJECTED) with a per-version file history. Existing rows keep their
-- file as the implicit version 1 (currentVersion defaults to 1) and
-- start as DRAFT, so nothing already stored reads as reviewed.
CREATE TYPE "MemberDocumentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

ALTER TABLE "member_documents"
  ADD COLUMN "status" "MemberDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedByUserId" TEXT,
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "member_documents"
  ADD CONSTRAINT "member_documents_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "member_document_versions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "fileId" TEXT NOT NULL,
  "changeNotes" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_document_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_document_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "member_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_document_versions_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_document_versions_documentId_version_key" UNIQUE ("documentId", "version")
);
CREATE INDEX "member_document_versions_documentId_version_idx" ON "member_document_versions"("documentId", "version");

-- The upload DTO has always accepted category DOCUMENT (see
-- CreateMemberDocumentDto) but the enum lacked the value, so DOCUMENT
-- uploads failed at the Prisma layer. Done as a type swap (not ALTER
-- TYPE ... ADD VALUE, which PostgreSQL refuses inside the transaction
-- Prisma Migrate wraps every migration in).
CREATE TYPE "MemberDocumentCategory_new" AS ENUM ('DOCUMENT', 'PROGRESS_PHOTO', 'ID_SCAN', 'OTHER');
ALTER TABLE "member_documents" ALTER COLUMN "category" TYPE "MemberDocumentCategory_new" USING "category"::text::"MemberDocumentCategory_new";
ALTER TYPE "MemberDocumentCategory" RENAME TO "MemberDocumentCategory_old";
ALTER TYPE "MemberDocumentCategory_new" RENAME TO "MemberDocumentCategory";
DROP TYPE "MemberDocumentCategory_old";
