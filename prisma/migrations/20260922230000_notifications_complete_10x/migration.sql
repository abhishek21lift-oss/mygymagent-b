ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "branchId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "entityType" TEXT,
  ADD COLUMN IF NOT EXISTS "entityId" TEXT,
  ADD COLUMN IF NOT EXISTS "groupKey" TEXT,
  ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "notifications_organizationId_userId_archivedAt_createdAt_idx"
  ON "notifications" ("organizationId", "userId", "archivedAt", "createdAt");

CREATE INDEX IF NOT EXISTS "notifications_organizationId_branchId_createdAt_idx"
  ON "notifications" ("organizationId", "branchId", "createdAt");

CREATE INDEX IF NOT EXISTS "notifications_organizationId_groupKey_createdAt_idx"
  ON "notifications" ("organizationId", "groupKey", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_organizationId_userId_dedupeKey_key"
  ON "notifications" ("organizationId", "userId", "dedupeKey");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_branchId_fkey') THEN
    ALTER TABLE "notifications"
      ADD CONSTRAINT "notifications_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_actorUserId_fkey') THEN
    ALTER TABLE "notifications"
      ADD CONSTRAINT "notifications_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;