-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "category" TEXT,
ADD COLUMN     "intent" TEXT,
ADD COLUMN     "leadLimit" INTEGER,
ADD COLUMN     "location" TEXT;

-- AlterTable
ALTER TABLE "ScrapeJob" ADD COLUMN     "candidatesDiscovered" INTEGER,
ADD COLUMN     "candidatesEnriched" INTEGER,
ADD COLUMN     "candidatesSkipped" INTEGER,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "discoveryActor" TEXT,
ADD COLUMN     "enrichmentActor" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "query" TEXT,
ADD COLUMN     "requestedLimit" INTEGER;
