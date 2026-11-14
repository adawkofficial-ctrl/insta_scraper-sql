-- Step 4: multi-attribute deduplication identity.
-- Non-destructive: only additive columns/tables/indexes + idempotent backfill.
-- No rows are deleted, no messages are moved.

-- AlterTable: additive identity columns on Lead
ALTER TABLE "Lead" ADD COLUMN     "dedupFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "dedupMatchedBy" TEXT,
ADD COLUMN     "duplicateOfLeadId" TEXT,
ADD COLUMN     "possibleDuplicateOfLeadId" TEXT,
ADD COLUMN     "possibleDuplicateReason" TEXT,
ADD COLUMN     "previousUsernames" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "profileUrlCanonical" TEXT,
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "usernameNormalized" TEXT,
ADD COLUMN     "websiteKey" TEXT;

-- CreateTable: cross-campaign provenance trail (never merges/deletes)
CREATE TABLE "LeadSighting" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "scrapeJobId" TEXT,
    "source" TEXT NOT NULL,
    "matchedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSighting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadSighting_leadId_idx" ON "LeadSighting"("leadId");
CREATE INDEX "LeadSighting_campaignId_createdAt_idx" ON "LeadSighting"("campaignId", "createdAt");
CREATE INDEX "LeadSighting_scrapeJobId_idx" ON "LeadSighting"("scrapeJobId");

CREATE INDEX "Lead_userId_idx" ON "Lead"("userId");
CREATE INDEX "Lead_userId_usernameNormalized_idx" ON "Lead"("userId", "usernameNormalized");
CREATE INDEX "Lead_userId_instagramUserId_idx" ON "Lead"("userId", "instagramUserId");
CREATE INDEX "Lead_userId_emailNormalized_idx" ON "Lead"("userId", "emailNormalized");
CREATE INDEX "Lead_userId_websiteKey_idx" ON "Lead"("userId", "websiteKey");
CREATE INDEX "Lead_duplicateOfLeadId_idx" ON "Lead"("duplicateOfLeadId");
CREATE INDEX "Lead_possibleDuplicateOfLeadId_idx" ON "Lead"("possibleDuplicateOfLeadId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_duplicateOfLeadId_fkey" FOREIGN KEY ("duplicateOfLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_possibleDuplicateOfLeadId_fkey" FOREIGN KEY ("possibleDuplicateOfLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeadSighting" ADD CONSTRAINT "LeadSighting_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadSighting" ADD CONSTRAINT "LeadSighting_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill owner from campaign (idempotent, non-destructive).
UPDATE "Lead" l
SET "userId" = c."userId"
FROM "Campaign" c
WHERE l."campaignId" = c."id" AND l."userId" IS NULL;

-- Backfill normalized identity keys (idempotent, non-destructive).
UPDATE "Lead"
SET "usernameNormalized" = lower(trim(both '@' from trim("username")))
WHERE "usernameNormalized" IS NULL AND "username" IS NOT NULL;

UPDATE "Lead"
SET "profileUrlCanonical" = 'https://www.instagram.com/' || "usernameNormalized" || '/'
WHERE "profileUrlCanonical" IS NULL AND "usernameNormalized" IS NOT NULL;
