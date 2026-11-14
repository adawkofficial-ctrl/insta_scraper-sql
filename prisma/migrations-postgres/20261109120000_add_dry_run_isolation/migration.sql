-- AlterTable
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "isDryRun" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "isDryRun" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing dry-run Leads
UPDATE "Lead"
SET "isDryRun" = true
WHERE "source" IN ('dry_run', 'sample')
   OR "source" LIKE 'sample_%'
   OR "username" LIKE 'sample_business_%'
   OR "username" LIKE 'sample_ig_place_%'
   OR "website" LIKE '%example.com%'
   OR "phone" LIKE '%555-01%'
   OR "gmapsPlaceId" LIKE 'ChIJmockPlace%';

-- Backfill existing dry-run ScrapeJobs
UPDATE "ScrapeJob"
SET "isDryRun" = true
WHERE ("usage"->>'isDryRun')::boolean = true
   OR "usage"::text LIKE '%dry_run_%'
   OR "errorMessage" LIKE '%dry_run_%';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_isDryRun_idx" ON "Lead"("isDryRun");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_campaignId_isDryRun_idx" ON "Lead"("campaignId", "isDryRun");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScrapeJob_isDryRun_idx" ON "ScrapeJob"("isDryRun");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScrapeJob_campaignId_isDryRun_idx" ON "ScrapeJob"("campaignId", "isDryRun");

