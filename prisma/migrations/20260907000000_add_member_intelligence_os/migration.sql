-- CreateEnum: RiskLevel
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum: RiskTrend
CREATE TYPE "RiskTrend" AS ENUM ('IMPROVING', 'STABLE', 'WORSENING');

-- CreateEnum: ActionType
CREATE TYPE "ActionType" AS ENUM ('OUTREACH_CHURN_RISK', 'RENEWAL_NUDGE', 'PAYMENT_PLAN', 'FREEZE_OFFER', 'UPGRADE_PITCH', 'ASSESSMENT_BOOK', 'LOYALTY_REWARD', 'RE_ENGAGEMENT');

-- CreateEnum: Priority
CREATE TYPE "Priority" AS ENUM ('P0', 'P1', 'P2');

-- CreateEnum: ChannelType
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL', 'IN_PERSON', 'CALL');

-- CreateEnum: ActionStatus
CREATE TYPE "ActionStatus" AS ENUM ('PENDING', 'ASSIGNED', 'COMPLETED', 'DISMISSED', 'AUTOMATED');

-- CreateTable: member_risk_profiles
CREATE TABLE "member_risk_profiles" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL UNIQUE,
    "overallScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "trend" "RiskTrend" NOT NULL DEFAULT 'STABLE',
    "contributingFactors" JSONB NOT NULL DEFAULT '[]',
    "protectiveFactors" TEXT[] NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable: member_segments
CREATE TABLE "member_segments" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable: member_segment_assignments
CREATE TABLE "member_segment_assignments" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "memberId" TEXT NOT NULL,
    "segmentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_segment_assignments_memberId_fkey"
        FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE,
    CONSTRAINT "member_segment_assignments_segmentId_fkey"
        FOREIGN KEY ("segmentId") REFERENCES "member_segments"("id") ON DELETE CASCADE
);

-- CreateTable: recommended_actions
CREATE TABLE "recommended_actions" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    CONSTRAINT "recommended_actions_memberId_fkey"
        FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE,
    CONSTRAINT "recommended_actions_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);

-- CreateIndexes
CREATE INDEX "member_risk_profiles_organizationId_riskLevel_idx"
    ON "member_risk_profiles"("organizationId", "riskLevel");
CREATE INDEX "member_risk_profiles_organizationId_computedAt_idx"
    ON "member_risk_profiles"("organizationId", "computedAt");
CREATE INDEX "member_segments_organizationId_isSystem_idx"
    ON "member_segments"("organizationId", "isSystem");
CREATE UNIQUE INDEX "member_segment_assignments_memberId_segmentId_key"
    ON "member_segment_assignments"("memberId", "segmentId");
CREATE INDEX "recommended_actions_organizationId_status_idx"
    ON "recommended_actions"("organizationId", "status");
CREATE INDEX "recommended_actions_organizationId_memberId_idx"
    ON "recommended_actions"("organizationId", "memberId");
