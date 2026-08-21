-- CreateEnum
CREATE TYPE "MemberAddressType" AS ENUM ('HOME', 'WORK', 'BILLING', 'OTHER');

-- CreateEnum
CREATE TYPE "MemberConsentType" AS ENUM ('WAIVER', 'MARKETING', 'PHOTO_RELEASE', 'DATA_PROCESSING', 'OTHER');

-- CreateTable
CREATE TABLE "member_addresses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" "MemberAddressType" NOT NULL DEFAULT 'HOME',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_emergency_contacts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "relationship" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_consents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" "MemberConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "note" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_status_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "fromStatus" "MemberStatus",
    "toStatus" "MemberStatus" NOT NULL,
    "changedByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_branch_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "fromBranchId" TEXT,
    "toBranchId" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_branch_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_trainer_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "fromTrainerId" TEXT,
    "toTrainerId" TEXT,
    "changedByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_trainer_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_addresses_organizationId_memberId_idx" ON "member_addresses"("organizationId", "memberId");

-- CreateIndex
CREATE INDEX "member_emergency_contacts_organizationId_memberId_idx" ON "member_emergency_contacts"("organizationId", "memberId");

-- CreateIndex
CREATE INDEX "member_notes_organizationId_memberId_createdAt_idx" ON "member_notes"("organizationId", "memberId", "createdAt");

-- CreateIndex
CREATE INDEX "member_consents_organizationId_memberId_type_idx" ON "member_consents"("organizationId", "memberId", "type");

-- CreateIndex
CREATE INDEX "member_status_history_organizationId_memberId_createdAt_idx" ON "member_status_history"("organizationId", "memberId", "createdAt");

-- CreateIndex
CREATE INDEX "member_branch_history_organizationId_memberId_createdAt_idx" ON "member_branch_history"("organizationId", "memberId", "createdAt");

-- CreateIndex
CREATE INDEX "member_trainer_history_organizationId_memberId_createdAt_idx" ON "member_trainer_history"("organizationId", "memberId", "createdAt");

-- AddForeignKey
ALTER TABLE "member_addresses" ADD CONSTRAINT "member_addresses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_addresses" ADD CONSTRAINT "member_addresses_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_emergency_contacts" ADD CONSTRAINT "member_emergency_contacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_emergency_contacts" ADD CONSTRAINT "member_emergency_contacts_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_notes" ADD CONSTRAINT "member_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_notes" ADD CONSTRAINT "member_notes_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_notes" ADD CONSTRAINT "member_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_consents" ADD CONSTRAINT "member_consents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_consents" ADD CONSTRAINT "member_consents_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_consents" ADD CONSTRAINT "member_consents_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_status_history" ADD CONSTRAINT "member_status_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_status_history" ADD CONSTRAINT "member_status_history_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_status_history" ADD CONSTRAINT "member_status_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_branch_history" ADD CONSTRAINT "member_branch_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_branch_history" ADD CONSTRAINT "member_branch_history_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_branch_history" ADD CONSTRAINT "member_branch_history_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_branch_history" ADD CONSTRAINT "member_branch_history_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_branch_history" ADD CONSTRAINT "member_branch_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_trainer_history" ADD CONSTRAINT "member_trainer_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_trainer_history" ADD CONSTRAINT "member_trainer_history_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_trainer_history" ADD CONSTRAINT "member_trainer_history_fromTrainerId_fkey" FOREIGN KEY ("fromTrainerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_trainer_history" ADD CONSTRAINT "member_trainer_history_toTrainerId_fkey" FOREIGN KEY ("toTrainerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_trainer_history" ADD CONSTRAINT "member_trainer_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
