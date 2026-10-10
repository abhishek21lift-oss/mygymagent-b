-- Command Center cards aggregate the trailing 24h across EVERY tenant
-- (organizationId is a grouping dimension on those cards, not a filter),
-- so the org-led indexes cannot serve them. Each console refresh used to
-- seq-scan the two highest-volume telemetry tables -- the page meant to
-- explain load was adding to it. These match the exact filters the
-- collectors issue.
--
-- NOTE for production deploys: Prisma runs migrations inside a
-- transaction, so these are plain CREATE INDEX and hold a SHARE lock
-- (blocking writes) on each table for the build time. On tables big
-- enough for that to matter, apply the statements above manually with
-- CREATE INDEX CONCURRENTLY (outside a transaction), then record the
-- migration as applied:
--   npx prisma migrate resolve --applied 20261010230000_command_center_scan_indexes

-- CreateIndex
CREATE INDEX "ai_usage_logs_createdAt_idx" ON "ai_usage_logs"("createdAt");

-- CreateIndex
CREATE INDEX "message_logs_channel_createdAt_idx" ON "message_logs"("channel", "createdAt");
