-- AlterTable
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "isGroup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "groupKey" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "lastHandleEnrichmentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_groupKey_idx" ON "Lead"("groupKey");
CREATE INDEX IF NOT EXISTS "Lead_campaignId_groupKey_idx" ON "Lead"("campaignId", "groupKey");

