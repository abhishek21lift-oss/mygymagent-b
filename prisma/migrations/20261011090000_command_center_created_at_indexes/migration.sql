-- Follow-up to the command-center scan indexes: the messaging and
-- automation cards filter on createdAt ALONE (they split by channel/key
-- in JS), so the channel-led message_logs index from that migration
-- cannot serve them. Each console refresh would otherwise seq-scan both
-- tables once message volume grows.
--
-- NOTE for production deploys: Prisma runs migrations inside a
-- transaction, so these are plain CREATE INDEX and hold a SHARE lock
-- (blocking writes) on each table for the build time. On tables big
-- enough for that to matter, apply the statements below manually with
-- CREATE INDEX CONCURRENTLY (outside a transaction), then record the
-- migration as applied:
--   npx prisma migrate resolve --applied 20261011090000_command_center_created_at_indexes

-- CreateIndex
CREATE INDEX "message_logs_createdAt_idx" ON "message_logs"("createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_createdAt_idx" ON "automation_runs"("createdAt");
