-- CreateMemberTag
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_tags'
  ) THEN
    CREATE TABLE "member_tags" (
        "id" TEXT NOT NULL,
        "organizationId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "color" TEXT NOT NULL DEFAULT '#6366f1',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "member_tags_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_tags_organizationId_name_key'
  ) THEN
    CREATE UNIQUE INDEX "member_tags_organizationId_name_key" ON "member_tags"("organizationId", "name");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_tags_organizationId_idx'
  ) THEN
    CREATE INDEX "member_tags_organizationId_idx" ON "member_tags"("organizationId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_tags_organizationId_fkey'
  ) THEN
    ALTER TABLE "member_tags" ADD CONSTRAINT "member_tags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateMemberTagAssignment
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_tag_assignments'
  ) THEN
    CREATE TABLE "member_tag_assignments" (
        "id" TEXT NOT NULL,
        "organizationId" TEXT NOT NULL,
        "memberId" TEXT NOT NULL,
        "tagId" TEXT NOT NULL,
        "assignedByUserId" TEXT,
        "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "member_tag_assignments_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_tag_assignments_memberId_tagId_key'
  ) THEN
    CREATE UNIQUE INDEX "member_tag_assignments_memberId_tagId_key" ON "member_tag_assignments"("memberId", "tagId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_tag_assignments_organizationId_memberId_idx'
  ) THEN
    CREATE INDEX "member_tag_assignments_organizationId_memberId_idx" ON "member_tag_assignments"("organizationId", "memberId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'member_tag_assignments_organizationId_tagId_idx'
  ) THEN
    CREATE INDEX "member_tag_assignments_organizationId_tagId_idx" ON "member_tag_assignments"("organizationId", "tagId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_tag_assignments_organizationId_fkey'
  ) THEN
    ALTER TABLE "member_tag_assignments" ADD CONSTRAINT "member_tag_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_tag_assignments_memberId_fkey'
  ) THEN
    ALTER TABLE "member_tag_assignments" ADD CONSTRAINT "member_tag_assignments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_tag_assignments_tagId_fkey'
  ) THEN
    ALTER TABLE "member_tag_assignments" ADD CONSTRAINT "member_tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "member_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'member_tag_assignments_assignedByUserId_fkey'
  ) THEN
    ALTER TABLE "member_tag_assignments" ADD CONSTRAINT "member_tag_assignments_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
