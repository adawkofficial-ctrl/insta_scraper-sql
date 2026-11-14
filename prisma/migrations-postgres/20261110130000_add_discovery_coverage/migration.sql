-- Coverage ledger for Google Maps discovery (keyword x area cooldown + overlap).
CREATE TABLE "DiscoveryCoverage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT,
    "keyword" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placeIds" JSONB NOT NULL,
    "newPlaces" INTEGER NOT NULL DEFAULT 0,
    "acceptedLeads" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryCoverage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoveryCoverage_userId_keyword_area_runDate_idx" ON "DiscoveryCoverage"("userId", "keyword", "area", "runDate");
CREATE INDEX "DiscoveryCoverage_userId_runDate_idx" ON "DiscoveryCoverage"("userId", "runDate");

-- Place outcome cache (90-day default) so paid places are never re-enriched/re-gated.
CREATE TABLE "DiscoveryPlaceOutcome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "keyword" TEXT,
    "area" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryPlaceOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveryPlaceOutcome_userId_placeId_key" ON "DiscoveryPlaceOutcome"("userId", "placeId");
CREATE INDEX "DiscoveryPlaceOutcome_userId_updatedAt_idx" ON "DiscoveryPlaceOutcome"("userId", "updatedAt");
