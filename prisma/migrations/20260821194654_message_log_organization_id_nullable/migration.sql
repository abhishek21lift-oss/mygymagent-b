-- DropForeignKey
ALTER TABLE "message_logs" DROP CONSTRAINT "message_logs_organizationId_fkey";

-- AlterTable
ALTER TABLE "message_logs" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
