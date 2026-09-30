-- CreateEnum
CREATE TYPE "WhatsappWebStatus" AS ENUM ('DISCONNECTED', 'PAIRING', 'CONNECTED', 'LOGGED_OUT');

-- CreateTable
CREATE TABLE "whatsapp_web_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "WhatsappWebStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "phoneNumber" TEXT,
    "useForSending" BOOLEAN NOT NULL DEFAULT false,
    "dailyLimit" INTEGER NOT NULL DEFAULT 200,
    "riskAcceptedAt" TIMESTAMP(3),
    "riskAcceptedByUserId" TEXT,
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_web_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_web_auth_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_web_auth_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_web_sessions_organizationId_key" ON "whatsapp_web_sessions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_web_auth_keys_organizationId_key_key" ON "whatsapp_web_auth_keys"("organizationId", "key");

-- AddForeignKey
ALTER TABLE "whatsapp_web_sessions" ADD CONSTRAINT "whatsapp_web_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_web_auth_keys" ADD CONSTRAINT "whatsapp_web_auth_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

