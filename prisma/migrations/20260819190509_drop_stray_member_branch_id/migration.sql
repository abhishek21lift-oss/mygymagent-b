/*
  Warnings:

  - You are about to drop the column `branchId` on the `members` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "members" DROP CONSTRAINT "members_branchId_fkey";

-- AlterTable
ALTER TABLE "members" DROP COLUMN "branchId";
