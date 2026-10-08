-- P3 segment broadcast: one staff-composed message fanned out per member.
-- MessageLog.broadcastId links delivery rows back for progress.
CREATE TYPE "BroadcastStatus" AS ENUM ('PENDING', 'SENDING', 'DONE', 'CANCELLED');
CREATE TABLE "broadcasts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "segmentId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "mediaFileId" TEXT,
  "sendAt" TIMESTAMP(3),
  "status" "BroadcastStatus" NOT NULL DEFAULT 'PENDING',
  "total" INTEGER NOT NULL DEFAULT 0,
  "queued" INTEGER NOT NULL DEFAULT 0,
  "sent" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "broadcasts_organizationId_status_idx" ON "broadcasts"("organizationId", "status");
ALTER TABLE "message_logs" ADD COLUMN "broadcastId" TEXT;
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "message_logs_broadcastId_idx" ON "message_logs"("broadcastId");
