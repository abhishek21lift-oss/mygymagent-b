-- CreateTable
CREATE TABLE "bot_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '#',
    "enablePing" BOOLEAN NOT NULL DEFAULT false,
    "enableUptime" BOOLEAN NOT NULL DEFAULT false,
    "welcomeMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_configs_organizationId_key" ON "bot_configs"("organizationId");

-- AddForeignKey
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
