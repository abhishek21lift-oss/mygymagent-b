-- AlterTable
ALTER TABLE "membership_plans" ADD COLUMN     "code" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT true;
