-- WS-3 speed-to-lead + access gate: LeadSourceEvent + LeadSourceChannel,
-- Branch.deviceKey for biometric devices, Attendance.deniedReason +
-- BIOMETRIC method, MemberQrToken + DeviceMap, and the LEAD_FIRST_TOUCH
-- automation key. Mirrors prisma/schema.prisma exactly (table names via
-- @@map, onDelete actions, defaults, indexes).
--
-- NOTE: AttendanceMethod already contains QR (20260819170156_init), so only
-- BIOMETRIC is added here. QR is not re-added.

-- CreateEnum
CREATE TYPE "LeadSourceChannel" AS ENUM ('WEB_FORM', 'WHATSAPP', 'WALKIN', 'IMPORT', 'MANUAL');

-- AlterEnum (additive only -- existing values untouched)
ALTER TYPE "AutomationKey" ADD VALUE 'LEAD_FIRST_TOUCH';
ALTER TYPE "AttendanceMethod" ADD VALUE 'BIOMETRIC';

-- CreateTable
CREATE TABLE "lead_source_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT,
    "channel" "LeadSourceChannel" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_source_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_qr_tokens" (
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "rotatesAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_qr_tokens_pkey" PRIMARY KEY ("memberId")
);

-- CreateTable
CREATE TABLE "device_maps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_maps_pkey" PRIMARY KEY ("id")
);

-- AlterTable (access-gate columns)
ALTER TABLE "attendances" ADD COLUMN "deniedReason" TEXT;
ALTER TABLE "branches" ADD COLUMN "deviceKey" TEXT;

-- CreateIndex
CREATE INDEX "lead_source_events_organizationId_createdAt_idx" ON "lead_source_events"("organizationId", "createdAt");
CREATE INDEX "lead_source_events_leadId_idx" ON "lead_source_events"("leadId");
CREATE UNIQUE INDEX "member_qr_tokens_memberId_key" ON "member_qr_tokens"("memberId");
CREATE UNIQUE INDEX "member_qr_tokens_tokenHash_key" ON "member_qr_tokens"("tokenHash");
CREATE UNIQUE INDEX "device_maps_organizationId_branchId_externalUserId_key" ON "device_maps"("organizationId", "branchId", "externalUserId");
CREATE UNIQUE INDEX "branches_deviceKey_key" ON "branches"("deviceKey");

-- AddForeignKey
ALTER TABLE "lead_source_events" ADD CONSTRAINT "lead_source_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_source_events" ADD CONSTRAINT "lead_source_events_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_qr_tokens" ADD CONSTRAINT "member_qr_tokens_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_maps" ADD CONSTRAINT "device_maps_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_maps" ADD CONSTRAINT "device_maps_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_maps" ADD CONSTRAINT "device_maps_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
