-- Branch of the sender, so branch-scoped staff only see their own broadcasts.
-- Nullable: existing rows stay org-wide (visible to org-wide callers only).
-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "broadcasts_organizationId_branchId_idx" ON "broadcasts"("organizationId", "branchId");
