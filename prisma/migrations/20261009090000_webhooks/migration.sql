-- P5 outgoing webhooks: subscriptions and delivery log.
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
CREATE TABLE "webhook_subscriptions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "events" TEXT[] NOT NULL,
  "secret" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "webhook_subscriptions_organizationId_url_key" ON "webhook_subscriptions"("organizationId", "url");
CREATE INDEX "webhook_subscriptions_organizationId_enabled_idx" ON "webhook_subscriptions"("organizationId", "enabled");
CREATE TABLE "webhook_deliveries" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "httpStatus" INTEGER,
  "error" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "webhook_deliveries_organizationId_createdAt_idx" ON "webhook_deliveries"("organizationId", "createdAt");
CREATE INDEX "webhook_deliveries_subscriptionId_createdAt_idx" ON "webhook_deliveries"("subscriptionId", "createdAt");
