-- CreateEnum
CREATE TYPE "MemberAssessmentType" AS ENUM ('INITIAL', 'PROGRESS', 'PAR_Q', 'FITNESS_TEST', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MemberGoalCategory" AS ENUM ('WEIGHT_LOSS', 'MUSCLE_GAIN', 'STRENGTH', 'ENDURANCE', 'GENERAL_FITNESS', 'OTHER');

-- CreateEnum
CREATE TYPE "MemberGoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'ABANDONED', 'PAUSED');

-- CreateTable
CREATE TABLE "member_assessments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" "MemberAssessmentType" NOT NULL,
    "notes" TEXT,
    "conductedByUserId" TEXT,
    "conductedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_measurements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "assessmentId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weightKg" DECIMAL(6,2),
    "heightCm" DECIMAL(6,2),
    "bodyFatPercent" DECIMAL(5,2),
    "muscleMassKg" DECIMAL(6,2),
    "waistCm" DECIMAL(6,2),
    "hipCm" DECIMAL(6,2),
    "chestCm" DECIMAL(6,2),
    "restingHeartRate" INTEGER,
    "bloodPressureSystolic" INTEGER,
    "bloodPressureDiastolic" INTEGER,
    "notes" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_fitness_test_results" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "assessmentId" TEXT,
    "testName" TEXT NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "notes" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_fitness_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_screenings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "assessmentId" TEXT,
    "responses" JSONB NOT NULL,
    "flaggedForMedicalClearance" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_goals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "MemberGoalCategory" NOT NULL DEFAULT 'GENERAL_FITNESS',
    "status" "MemberGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetValue" DECIMAL(10,2),
    "targetUnit" TEXT,
    "baselineValue" DECIMAL(10,2),
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetDate" TIMESTAMP(3),
    "achievedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_goal_milestones" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetDate" TIMESTAMP(3),
    "achievedAt" TIMESTAMP(3),
    "value" DECIMAL(10,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_goal_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_assessments_organizationId_memberId_conductedAt_idx" ON "member_assessments"("organizationId", "memberId", "conductedAt");

-- CreateIndex
CREATE INDEX "member_measurements_organizationId_memberId_recordedAt_idx" ON "member_measurements"("organizationId", "memberId", "recordedAt");

-- CreateIndex
CREATE INDEX "member_fitness_test_results_organizationId_memberId_testNam_idx" ON "member_fitness_test_results"("organizationId", "memberId", "testName", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "member_screenings_assessmentId_key" ON "member_screenings"("assessmentId");

-- CreateIndex
CREATE INDEX "member_screenings_organizationId_memberId_completedAt_idx" ON "member_screenings"("organizationId", "memberId", "completedAt");

-- CreateIndex
CREATE INDEX "member_goals_organizationId_memberId_status_idx" ON "member_goals"("organizationId", "memberId", "status");

-- CreateIndex
CREATE INDEX "member_goal_milestones_organizationId_goalId_idx" ON "member_goal_milestones"("organizationId", "goalId");

-- AddForeignKey
ALTER TABLE "member_assessments" ADD CONSTRAINT "member_assessments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_assessments" ADD CONSTRAINT "member_assessments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_assessments" ADD CONSTRAINT "member_assessments_conductedByUserId_fkey" FOREIGN KEY ("conductedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_measurements" ADD CONSTRAINT "member_measurements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_measurements" ADD CONSTRAINT "member_measurements_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_measurements" ADD CONSTRAINT "member_measurements_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "member_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_measurements" ADD CONSTRAINT "member_measurements_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_fitness_test_results" ADD CONSTRAINT "member_fitness_test_results_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_fitness_test_results" ADD CONSTRAINT "member_fitness_test_results_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_fitness_test_results" ADD CONSTRAINT "member_fitness_test_results_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "member_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_fitness_test_results" ADD CONSTRAINT "member_fitness_test_results_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_screenings" ADD CONSTRAINT "member_screenings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_screenings" ADD CONSTRAINT "member_screenings_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_screenings" ADD CONSTRAINT "member_screenings_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "member_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_screenings" ADD CONSTRAINT "member_screenings_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_goals" ADD CONSTRAINT "member_goals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_goals" ADD CONSTRAINT "member_goals_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_goals" ADD CONSTRAINT "member_goals_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_goal_milestones" ADD CONSTRAINT "member_goal_milestones_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_goal_milestones" ADD CONSTRAINT "member_goal_milestones_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "member_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
