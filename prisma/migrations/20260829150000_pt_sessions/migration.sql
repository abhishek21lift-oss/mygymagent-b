-- PT Sessions table
-- Personal training sessions booked between members and trainers.
-- Created as a separate migration to fix the ordering issue with pt_packages_v1,
-- which references this table via a foreign key.

-- CreateEnum
CREATE TYPE "PtSessionType" AS ENUM ('PERSONAL_TRAINING', 'PARTNER_TRAINING', 'SMALL_GROUP');

-- CreateEnum
CREATE TYPE "PtSessionStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "pt_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "trainerId" TEXT,
    "branchId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "type" "PtSessionType" NOT NULL DEFAULT 'PERSONAL_TRAINING',
    "status" "PtSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "price" DECIMAL(10,2),
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pt_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pt_sessions_organizationId_branchId_startTime_idx" ON "pt_sessions"("organizationId", "branchId", "startTime");

-- CreateIndex
CREATE INDEX "pt_sessions_memberId_startTime_idx" ON "pt_sessions"("memberId", "startTime");

-- CreateIndex
CREATE INDEX "pt_sessions_trainerId_startTime_idx" ON "pt_sessions"("trainerId", "startTime");

-- AddForeignKey
ALTER TABLE "pt_sessions" ADD CONSTRAINT "pt_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pt_sessions" ADD CONSTRAINT "pt_sessions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pt_sessions" ADD CONSTRAINT "pt_sessions_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pt_sessions" ADD CONSTRAINT "pt_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
