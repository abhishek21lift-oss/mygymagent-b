-- CreateEnum
CREATE TYPE "DietAssignmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "food_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "servingSize" TEXT,
    "calories" INTEGER,
    "proteinG" DECIMAL(6,2),
    "carbsG" DECIMAL(6,2),
    "fatG" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_plans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "targetCalories" INTEGER,
    "targetProteinG" DECIMAL(6,2),
    "targetCarbsG" DECIMAL(6,2),
    "targetFatG" DECIMAL(6,2),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diet_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dietPlanId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "assignedByUserId" TEXT,
    "status" "DietAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diet_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "food_items_organizationId_idx" ON "food_items"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "food_items_organizationId_name_key" ON "food_items"("organizationId", "name");

-- CreateIndex
CREATE INDEX "diet_plans_organizationId_idx" ON "diet_plans"("organizationId");

-- CreateIndex
CREATE INDEX "diet_assignments_organizationId_idx" ON "diet_assignments"("organizationId");

-- CreateIndex
CREATE INDEX "diet_assignments_memberId_idx" ON "diet_assignments"("memberId");

-- CreateIndex
CREATE INDEX "diet_assignments_dietPlanId_idx" ON "diet_assignments"("dietPlanId");

-- AddForeignKey
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_plans" ADD CONSTRAINT "diet_plans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_plans" ADD CONSTRAINT "diet_plans_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_assignments" ADD CONSTRAINT "diet_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_assignments" ADD CONSTRAINT "diet_assignments_dietPlanId_fkey" FOREIGN KEY ("dietPlanId") REFERENCES "diet_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_assignments" ADD CONSTRAINT "diet_assignments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_assignments" ADD CONSTRAINT "diet_assignments_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
