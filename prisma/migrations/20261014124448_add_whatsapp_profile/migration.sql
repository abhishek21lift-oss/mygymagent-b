-- AlterTable
ALTER TABLE "automation_settings" ADD COLUMN     "runAt" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "salutation" TEXT NOT NULL DEFAULT 'Hello',
    "autoResend" BOOLEAN NOT NULL DEFAULT false,
    "maxResendAttempts" INTEGER NOT NULL DEFAULT 3,
    "defaultCountryCode" TEXT NOT NULL DEFAULT '91',
    "customBillMessage" TEXT,
    "irregularThresholdDays" INTEGER NOT NULL DEFAULT 14,
    "irregularCustomDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_profiles_organizationId_key" ON "whatsapp_profiles"("organizationId");

-- CreateIndex
CREATE INDEX "whatsapp_profiles_organizationId_idx" ON "whatsapp_profiles"("organizationId");

-- AddForeignKey
ALTER TABLE "whatsapp_profiles" ADD CONSTRAINT "whatsapp_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
