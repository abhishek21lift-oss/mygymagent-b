-- CreateEnum
CREATE TYPE "MfaPolicy" AS ENUM ('OPTIONAL', 'REQUIRED_FOR_PRIVILEGED');

-- AlterTable
-- Defaulting to OPTIONAL keeps every existing organization on exactly the
-- behaviour it has today: turning enforcement on is an explicit act.
ALTER TABLE "organizations"
  ADD COLUMN "mfaPolicy" "MfaPolicy" NOT NULL DEFAULT 'OPTIONAL',
  ADD COLUMN "mfaGraceUntil" TIMESTAMP(3);
