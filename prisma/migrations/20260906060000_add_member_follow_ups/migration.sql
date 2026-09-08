-- Ensure MemberFollowUpPriority enum exists
DO $$
BEGIN
  CREATE TYPE "MemberFollowUpPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateMemberFollowUp
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_follow_ups'
  ) THEN
    CREATE TABLE "member_follow_ups" (
        "id" TEXT NOT NULL,
        "organizationId" TEXT NOT NULL,
        "memberId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "dueAt" TIMESTAMP(3),
        "completedAt" TIMESTAMP(3),
        "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
        "createdByUserId" TEXT,
        "assignedToUserId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "member_follow_ups_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_follow_ups_organizationId_memberId_idx'
  ) THEN
    CREATE INDEX "member_follow_ups_organizationId_memberId_idx" ON "member_follow_ups"("organizationId", "memberId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_follow_ups_organizationId_dueAt_idx'
  ) THEN
    CREATE INDEX "member_follow_ups_organizationId_dueAt_idx" ON "member_follow_ups"("organizationId", "dueAt");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_follow_ups_memberId_fkey'
  ) THEN
    ALTER TABLE "member_follow_ups" ADD CONSTRAINT "member_follow_ups_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_follow_ups_organizationId_fkey'
  ) THEN
    ALTER TABLE "member_follow_ups" ADD CONSTRAINT "member_follow_ups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_follow_ups_createdByUserId_fkey'
  ) THEN
    ALTER TABLE "member_follow_ups" ADD CONSTRAINT "member_follow_ups_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_follow_ups_assignedToUserId_fkey'
  ) THEN
    ALTER TABLE "member_follow_ups" ADD CONSTRAINT "member_follow_ups_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
