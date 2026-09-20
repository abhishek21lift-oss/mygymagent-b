CREATE TABLE "notifications" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "actionUrl" TEXT,
  "metadata" JSONB,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

);

CREATE TABLE "notification_preferences" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "inApp" BOOLEAN NOT NULL DEFAULT true,
  "email" BOOLEAN NOT NULL DEFAULT true,
  "whatsapp" BOOLEAN NOT NULL DEFAULT false,
  "sms" BOOLEAN NOT NULL DEFAULT false,
  "push" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

);

CREATE INDEX "notifications_organizationId_userId_createdAt_idx"
  ON "notifications"("organizationId", "userId", "createdAt");
CREATE INDEX "notifications_organizationId_userId_readAt_idx"
  ON "notifications"("organizationId", "userId", "readAt");

CREATE UNIQUE INDEX "notification_preferences_organizationId_userId_category_key"
  ON "notification_preferences"("organizationId", "userId", "category");
CREATE INDEX "notification_preferences_organizationId_userId_idx"
  ON "notification_preferences"("organizationId", "userId");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;