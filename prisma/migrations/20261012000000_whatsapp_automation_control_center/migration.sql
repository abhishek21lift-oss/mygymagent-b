-- WhatsApp Automation Control Center: per-automation execution times plus
-- the org-scoped preference row (salutation, auto-resend, phone
-- normalization, bill-message override, irregular thresholds, timezone)
-- and the two keys the Control Center rows need (same-day expiry notice,
-- paid-balance receipt). Additive only: nullable column, new table, new
-- enum values; no existing row is touched and gyms without rows keep the
-- exact behavior they have today.
--
-- Mirrors prisma/schema.prisma exactly (table name via @@map, onDelete
-- Cascade, defaults, unique).

-- AlterEnum (additive only -- existing values untouched)
ALTER TYPE "AutomationKey" ADD VALUE 'MEMBERSHIP_EXPIRY_ON_DAY';
ALTER TYPE "AutomationKey" ADD VALUE 'PAYMENT_RECEIPT';

-- AlterTable (nullable: gyms without a saved time use the code default)
ALTER TABLE "automation_settings" ADD COLUMN "runAt" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_automation_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "salutation" TEXT NOT NULL DEFAULT 'Hello',
    "autoResend" BOOLEAN NOT NULL DEFAULT true,
    "maxResendAttempts" INTEGER NOT NULL DEFAULT 8,
    "defaultCountryCode" TEXT NOT NULL DEFAULT '91',
    "customBillMessage" TEXT,
    "irregularThresholdDays" INTEGER NOT NULL DEFAULT 7,
    "irregularCustomDays" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_automation_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_automation_profiles_organizationId_key" ON "whatsapp_automation_profiles"("organizationId");

-- AddForeignKey
ALTER TABLE "whatsapp_automation_profiles" ADD CONSTRAINT "whatsapp_automation_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
