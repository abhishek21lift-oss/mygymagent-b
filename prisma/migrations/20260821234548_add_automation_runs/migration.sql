-- CreateEnum
CREATE TYPE "AutomationKey" AS ENUM ('MEMBERSHIP_RENEWAL_REMINDER', 'PAYMENT_OVERDUE_REMINDER', 'MEMBER_INACTIVE_RECOVERY', 'LEAD_FOLLOWUP_REMINDER', 'LOW_STOCK_ALERT');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" "AutomationKey" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_runs_organizationId_key_subjectId_createdAt_idx" ON "automation_runs"("organizationId", "key", "subjectId", "createdAt");

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
