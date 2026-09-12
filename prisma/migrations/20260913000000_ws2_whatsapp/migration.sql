-- WS-2 WhatsApp backend: encrypted per-org credential vault
-- (AES-256-GCM ciphertext; the key lives in the WHATSAPP_TOKEN_KEY env var,
-- never in this table), the inbound-message inbox, the provider message id
-- on the delivery log, and the DELIVERED/READ delivery states advanced by
-- the WhatsApp status webhook. Mirrors prisma/schema.prisma exactly (table
-- names via @@map, onDelete actions, defaults, indexes).

-- AlterEnum (additive only -- existing values untouched)
ALTER TYPE "MessageStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "MessageStatus" ADD VALUE 'READ';

-- AlterTable (Meta `wamid` join key for webhook status callbacks)
ALTER TABLE "message_logs" ADD COLUMN "providerMessageId" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "matchedMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_logs_providerMessageId_idx" ON "message_logs"("providerMessageId");
CREATE UNIQUE INDEX "whatsapp_credentials_organizationId_key" ON "whatsapp_credentials"("organizationId");
CREATE INDEX "inbound_messages_organizationId_createdAt_idx" ON "inbound_messages"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "whatsapp_credentials" ADD CONSTRAINT "whatsapp_credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_matchedMemberId_fkey" FOREIGN KEY ("matchedMemberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
