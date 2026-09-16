-- Member Intelligence OS: churn risk profiles, segmentation and recommended
-- actions. Purely additive -- four new tables and their enums. Nothing here
-- touches an existing table.

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "RiskTrend" AS ENUM ('IMPROVING', 'STABLE', 'WORSENING');
CREATE TYPE "ActionType" AS ENUM ('OUTREACH_CHURN_RISK', 'RENEWAL_NUDGE', 'PAYMENT_PLAN', 'FREEZE_OFFER', 'UPGRADE_PITCH', 'ASSESSMENT_BOOK', 'LOYALTY_REWARD', 'RE_ENGAGEMENT');
CREATE TYPE "Priority" AS ENUM ('P0', 'P1', 'P2');
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL', 'IN_PERSON', 'CALL');
CREATE TYPE "ActionStatus" AS ENUM ('PENDING', 'ASSIGNED', 'COMPLETED', 'DISMISSED', 'AUTOMATED');

-- CreateTable
CREATE TABLE "member_risk_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "overallScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "trend" "RiskTrend" NOT NULL DEFAULT 'STABLE',
    "contributingFactors" JSONB NOT NULL DEFAULT '[]',
    "protectiveFactors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_risk_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_segments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_segment_assignments" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_segment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommended_actions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "priority" "Priority" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT NOT NULL,
    "suggestedChannel" "ChannelType",
    "suggestedContent" TEXT,
    "suggestedOfferType" TEXT,
    "discountPercent" INTEGER,
    "freezeDays" INTEGER,
    "status" "ActionStatus" NOT NULL DEFAULT 'PENDING',
    "assignedToUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommended_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_risk_profiles_memberId_key" ON "member_risk_profiles"("memberId");
CREATE INDEX "member_risk_profiles_organizationId_riskLevel_idx" ON "member_risk_profiles"("organizationId", "riskLevel");
CREATE INDEX "member_risk_profiles_organizationId_computedAt_idx" ON "member_risk_profiles"("organizationId", "computedAt");
CREATE INDEX "member_segments_organizationId_isSystem_idx" ON "member_segments"("organizationId", "isSystem");
CREATE UNIQUE INDEX "member_segment_assignments_memberId_segmentId_key" ON "member_segment_assignments"("memberId", "segmentId");
CREATE INDEX "recommended_actions_organizationId_status_idx" ON "recommended_actions"("organizationId", "status");
CREATE INDEX "recommended_actions_organizationId_memberId_idx" ON "recommended_actions"("organizationId", "memberId");

-- AddForeignKey
ALTER TABLE "member_risk_profiles" ADD CONSTRAINT "member_risk_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_risk_profiles" ADD CONSTRAINT "member_risk_profiles_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_segments" ADD CONSTRAINT "member_segments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_segment_assignments" ADD CONSTRAINT "member_segment_assignments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommended_actions" ADD CONSTRAINT "recommended_actions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommended_actions" ADD CONSTRAINT "recommended_actions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
