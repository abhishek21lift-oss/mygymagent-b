-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('TRANSACTIONAL', 'MARKETING');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_NO_CONSENT');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "emailFromName" TEXT,
ADD COLUMN     "emailReplyTo" TEXT;

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "memberId" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_templates_key_channel_idx" ON "message_templates"("key", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organizationId_key_channel_key" ON "message_templates"("organizationId", "key", "channel");

-- CreateIndex
CREATE INDEX "message_logs_organizationId_createdAt_idx" ON "message_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "message_logs_memberId_idx" ON "message_logs"("memberId");

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
