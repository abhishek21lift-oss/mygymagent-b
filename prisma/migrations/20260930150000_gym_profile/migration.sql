-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "instagram" TEXT,
ADD COLUMN     "logoKey" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "mapsUrl" TEXT,
ADD COLUMN     "openingHours" JSONB;
