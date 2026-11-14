-- CreateEnum
CREATE TYPE "LeadEventType" AS ENUM ('SENT', 'DELIVERED', 'REPLIED', 'POSITIVE_REPLY', 'NEGATIVE_REPLY', 'UNSUBSCRIBE_OR_DNC', 'MEETING_BOOKED', 'WON');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "autoOptimize" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "explorationBudgetShare" DOUBLE PRECISION NOT NULL DEFAULT 0.15;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "acquisitionCostBreakdown" JSONB,
ADD COLUMN "acquisitionCostUsd" DECIMAL(10,4),
ADD COLUMN "discoveryCity" TEXT,
ADD COLUMN "discoveryKeyword" TEXT,
ADD COLUMN "messageVariant" TEXT,
ADD COLUMN "scrapeJobId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "replyCategory" TEXT;

-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN "variants" JSONB;

-- AlterTable
ALTER TABLE "ScrapeJob" ADD COLUMN "costBreakdown" JSONB,
ADD COLUMN "costUsd" DECIMAL(10,4);

-- AlterTable
ALTER TABLE "UsageLog" ADD COLUMN "scrapeJobId" TEXT;

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "eventType" "LeadEventType" NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'INSTAGRAM',
    "messageId" TEXT,
    "variant" TEXT,
    "metadata" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadEvent_leadId_createdAt_idx" ON "LeadEvent"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadEvent_campaignId_eventType_idx" ON "LeadEvent"("campaignId", "eventType");

-- CreateIndex
CREATE INDEX "LeadEvent_campaignId_createdAt_idx" ON "LeadEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadEvent_eventType_createdAt_idx" ON "LeadEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "LeadEvent_campaignId_variant_idx" ON "LeadEvent"("campaignId", "variant");

-- CreateIndex
CREATE INDEX "Lead_scrapeJobId_idx" ON "Lead"("scrapeJobId");

-- CreateIndex
CREATE INDEX "Lead_discoveryKeyword_idx" ON "Lead"("discoveryKeyword");

-- CreateIndex
CREATE INDEX "Lead_discoveryCity_idx" ON "Lead"("discoveryCity");

-- CreateIndex
CREATE INDEX "Lead_messageVariant_idx" ON "Lead"("messageVariant");

-- CreateIndex
CREATE INDEX "UsageLog_scrapeJobId_idx" ON "UsageLog"("scrapeJobId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_scrapeJobId_fkey" FOREIGN KEY ("scrapeJobId") REFERENCES "ScrapeJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
