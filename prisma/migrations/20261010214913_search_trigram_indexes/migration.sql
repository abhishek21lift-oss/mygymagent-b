-- Trigram (GIN) indexes backing the global search's ILIKE '%term%'
-- probes on the member table. Without them the search seq-scans every
-- member row in the organization.
--
-- NOTE for production deploys on a large `members` table: Prisma runs
-- migrations inside a transaction, so these are plain CREATE INDEX and
-- will hold a SHARE lock (blocking writes) on `members` for the build
-- time. On a table big enough for that to matter, apply the four
-- statements above manually with CREATE INDEX CONCURRENTLY (outside a
-- transaction), then record the migration as applied:
--   npx prisma migrate resolve --applied 20261010214913_search_trigram_indexes

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "members_first_name_trgm_idx" ON "members" USING GIN ("firstName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "members_last_name_trgm_idx" ON "members" USING GIN ("lastName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "members_phone_trgm_idx" ON "members" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "members_email_trgm_idx" ON "members" USING GIN ("email" gin_trgm_ops);
