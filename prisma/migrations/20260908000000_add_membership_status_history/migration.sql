-- Membership Lifecycle OS: append-only status-history table, the same
-- pattern as member_status_history. Every lifecycle transition
-- (activate/freeze/resume/extend/change-plan/transfer/renew/expire/
-- cancel) writes a row here atomically with the membership update.

CREATE TABLE "membership_status_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "fromStatus" "MembershipStatus",
    "toStatus" "MembershipStatus" NOT NULL,
    "detail" TEXT,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "membership_status_history_organizationId_membershipId_creat_idx" ON "membership_status_history"("organizationId", "membershipId", "createdAt");

-- AddForeignKey
ALTER TABLE "membership_status_history" ADD CONSTRAINT "membership_status_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_status_history" ADD CONSTRAINT "membership_status_history_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_status_history" ADD CONSTRAINT "membership_status_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
