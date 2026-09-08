-- Calendar & Appointment OS: generic appointments (trials, consultations,
-- assessments, follow-ups), trainer weekly availability rules, trainer
-- time-off windows, and an appointment reminder automation key.

-- Additive enum value (safe on PG12+, value not used in this transaction).
ALTER TYPE "AutomationKey" ADD VALUE 'APPOINTMENT_REMINDER';

-- AlterTypes
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppointmentType') THEN
    CREATE TYPE "AppointmentType" AS ENUM ('TRIAL', 'CONSULTATION', 'ASSESSMENT', 'FOLLOW_UP', 'PT_SESSION', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppointmentStatus') THEN
    CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');
  END IF;
END
$$;

-- Table: appointments
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT,
    "memberId" TEXT,
    "leadId" TEXT,
    "type" "AppointmentType" NOT NULL DEFAULT 'OTHER',
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

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_organizationId_branchId_startTime_idx" ON "appointments"("organizationId", "branchId", "startTime");
CREATE INDEX "appointments_organizationId_status_startTime_idx" ON "appointments"("organizationId", "status", "startTime");
CREATE INDEX "appointments_staffId_startTime_idx" ON "appointments"("staffId", "startTime");
CREATE INDEX "appointments_memberId_startTime_idx" ON "appointments"("memberId", "startTime");
CREATE INDEX "appointments_leadId_idx" ON "appointments"("leadId");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE SET NULL;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_member_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_createdByUser_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL;

-- Table: trainer_availability_rules
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

    CONSTRAINT "trainer_availability_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trainer_availability_rules_organizationId_staffId_idx" ON "trainer_availability_rules"("organizationId", "staffId");

ALTER TABLE "trainer_availability_rules" ADD CONSTRAINT "trainer_availability_rules_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "trainer_availability_rules" ADD CONSTRAINT "trainer_availability_rules_staff_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE;
ALTER TABLE "trainer_availability_rules" ADD CONSTRAINT "trainer_availability_rules_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL;

-- Table: trainer_time_offs
CREATE TABLE "trainer_time_offs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "branchId" TEXT,
    "reason" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trainer_time_offs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trainer_time_offs_organizationId_staffId_startAt_idx" ON "trainer_time_offs"("organizationId", "staffId", "startAt");

ALTER TABLE "trainer_time_offs" ADD CONSTRAINT "trainer_time_offs_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "trainer_time_offs" ADD CONSTRAINT "trainer_time_offs_staff_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE;
ALTER TABLE "trainer_time_offs" ADD CONSTRAINT "trainer_time_offs_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL;
