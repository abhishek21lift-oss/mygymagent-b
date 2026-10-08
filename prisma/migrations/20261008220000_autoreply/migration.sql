-- P4 staff replies: keyword rules, #stop opt-outs, group filing.
CREATE TYPE "AutoReplyMatch" AS ENUM ('EXACT', 'CONTAINS', 'REGEX');
CREATE TYPE "AutoReplyScope" AS ENUM ('ALL', 'PRIVATE', 'GROUP');
CREATE TABLE "auto_reply_rules" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "matchType" "AutoReplyMatch" NOT NULL DEFAULT 'EXACT',
  "scope" "AutoReplyScope" NOT NULL DEFAULT 'ALL',
  "answer" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auto_reply_rules_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "auto_reply_rules" ADD CONSTRAINT "auto_reply_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "auto_reply_rules_organizationId_enabled_idx" ON "auto_reply_rules"("organizationId", "enabled");
CREATE TABLE "bot_opt_outs" (
  "organizationId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bot_opt_outs_pkey" PRIMARY KEY ("organizationId", "phone")
);
ALTER TABLE "bot_opt_outs" ADD CONSTRAINT "bot_opt_outs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbound_messages" ADD COLUMN "groupJid" TEXT;
