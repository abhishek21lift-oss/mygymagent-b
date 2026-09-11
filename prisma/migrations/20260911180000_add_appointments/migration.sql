CREATE TYPE "AppointmentType" AS ENUM ('TRIAL', 'CONSULTATION', 'ASSESSMENT', 'FOLLOW_UP', 'PT_SESSION', 'OTHER');
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');

CREATE TABLE "appointments" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
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
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "appointments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "trainer_availability_rules" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "branchId" TEXT,
  "dayOfWeek" INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "endMinute" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT "trainer_availability_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trainer_availability_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_availability_rules_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_availability_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_availability_rules_day_check" CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  CONSTRAINT "trainer_availability_rules_minutes_check" CHECK ("startMinute" >= 0 AND "startMinute" < "endMinute" AND "endMinute" <= 1440)
);

CREATE TABLE "trainer_time_offs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "branchId" TEXT,
  "reason" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trainer_time_offs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trainer_time_offs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_time_offs_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_time_offs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_time_offs_time_check" CHECK ("startAt" < "endAt")
);

CREATE INDEX "appointments_org_start_idx" ON "appointments"("organizationId", "startTime");
CREATE INDEX "appointments_org_branch_start_idx" ON "appointments"("organizationId", "branchId", "startTime");
CREATE INDEX "appointments_org_staff_start_idx" ON "appointments"("organizationId", "staffId", "startTime");
CREATE INDEX "appointments_org_member_start_idx" ON "appointments"("organizationId", "memberId", "startTime");
CREATE INDEX "appointments_org_status_idx" ON "appointments"("organizationId", "status");
CREATE INDEX "trainer_availability_org_staff_idx" ON "trainer_availability_rules"("organizationId", "staffId");
CREATE INDEX "trainer_time_off_org_staff_start_idx" ON "trainer_time_offs"("organizationId", "staffId", "startAt");
