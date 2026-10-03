-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('MANUAL', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "CampaignExecutionStatus" AS ENUM ('PREVIEW', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionItemStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "executionMode" "ExecutionMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "messageApprovalRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignExecution" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "CampaignExecutionStatus" NOT NULL DEFAULT 'PREVIEW',
    "executionMode" "ExecutionMode" NOT NULL DEFAULT 'MANUAL',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "successfulItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignExecutionItem" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "status" "ExecutionItemStatus" NOT NULL DEFAULT 'PENDING',
    "messageText" TEXT NOT NULL,
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignExecutionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignExecution_campaignId_idx" ON "CampaignExecution"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignExecution_status_idx" ON "CampaignExecution"("status");

-- CreateIndex
CREATE INDEX "CampaignExecution_createdAt_idx" ON "CampaignExecution"("createdAt");

-- CreateIndex
CREATE INDEX "CampaignExecutionItem_executionId_idx" ON "CampaignExecutionItem"("executionId");

-- CreateIndex
CREATE INDEX "CampaignExecutionItem_leadId_idx" ON "CampaignExecutionItem"("leadId");

-- CreateIndex
CREATE INDEX "CampaignExecutionItem_status_idx" ON "CampaignExecutionItem"("status");

-- CreateIndex
CREATE INDEX "CampaignExecutionItem_createdAt_idx" ON "CampaignExecutionItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignExecutionItem_executionId_leadId_key" ON "CampaignExecutionItem"("executionId", "leadId");

-- CreateIndex
CREATE INDEX "Campaign_executionMode_idx" ON "Campaign"("executionMode");

-- AddForeignKey
ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignExecutionItem" ADD CONSTRAINT "CampaignExecutionItem_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "CampaignExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignExecutionItem" ADD CONSTRAINT "CampaignExecutionItem_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
