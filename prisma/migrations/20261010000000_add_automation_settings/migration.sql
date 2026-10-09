-- WhatsApp Automation Control Center (Task 1): per-gym ON/OFF switches
-- plus stored schedule overrides, and the two keys the Control Center
-- schedules need (birthdays via Member.dateOfBirth, post-expiry
-- follow-ups -- renewal stages t7/t3/t0 already cover the pre-expiry
-- window under MEMBERSHIP_RENEWAL_REMINDER). Additive only: no drops,
-- no changes to existing rows; gyms without a row keep code defaults.
--
-- Mirrors prisma/schema.prisma exactly (table name via @@map, onDelete
-- Cascade, defaults, unique + index).

-- AlterEnum (additive only -- existing values untouched)
ALTER TYPE "AutomationKey" ADD VALUE 'BIRTHDAY_WISH';
ALTER TYPE "AutomationKey" ADD VALUE 'MEMBERSHIP_POST_EXPIRY';

-- CreateTable
CREATE TABLE "automation_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" "AutomationKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channelOverride" TEXT,
    "cooldownDays" INTEGER,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automation_settings_organizationId_key_key" ON "automation_settings"("organizationId", "key");
CREATE INDEX "automation_settings_organizationId_idx" ON "automation_settings"("organizationId");

-- AddForeignKey
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
