-- CreateEnum
CREATE TYPE "WaSessionStatus" AS ENUM ('DISCONNECTED', 'PAIRING', 'CONNECTED', 'LOGGED_OUT');

-- CreateTable
CREATE TABLE "wa_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "WaSessionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "qr" TEXT,
    "phoneNumber" TEXT,
    "pairingCode" TEXT,
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_auth_keys" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_auth_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wa_sessions_organizationId_key" ON "wa_sessions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "wa_sessions_sessionId_key" ON "wa_sessions"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "wa_auth_keys_sessionId_key_key" ON "wa_auth_keys"("sessionId", "key");

-- AddForeignKey
ALTER TABLE "wa_sessions" ADD CONSTRAINT "wa_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_auth_keys" ADD CONSTRAINT "wa_auth_keys_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "wa_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
