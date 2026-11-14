-- AlterEnum
ALTER TYPE "ScrapeJobStatus" ADD VALUE 'COMPLETED_WITH_WARNINGS';

-- AlterEnum
ALTER TYPE "LeadStatus" ADD VALUE 'ENRICH_PENDING';

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "scrapeJobId" TEXT,
    "runId" TEXT,
    "datasetId" TEXT,
    "costUsd" DECIMAL(10,4),
    "placeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "countryCode" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "rating" DOUBLE PRECISION,
    "reviewsCount" INTEGER,
    "mapsUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "rejectionReason" TEXT,
    "lastError" TEXT,
    "handle" TEXT,
    "handleSource" TEXT,
    "handleConfidence" TEXT,
    "socialLinks" JSONB,
    "rawPlaceData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Candidate_campaignId_status_idx" ON "Candidate"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Candidate_scrapeJobId_idx" ON "Candidate"("scrapeJobId");

-- CreateIndex
CREATE INDEX "Candidate_placeId_idx" ON "Candidate"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_campaignId_placeId_key" ON "Candidate"("campaignId", "placeId");

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_scrapeJobId_fkey" FOREIGN KEY ("scrapeJobId") REFERENCES "ScrapeJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

