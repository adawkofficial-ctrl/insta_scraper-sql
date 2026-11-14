-- CreateEnum
CREATE TYPE "CampaignExecutionPhase" AS ENUM ('DISCOVERY', 'ENRICHMENT', 'READY', 'MESSAGING', 'FINALIZING');

-- AlterEnum
ALTER TYPE "CampaignExecutionStatus" ADD VALUE 'DRAFT';
ALTER TYPE "CampaignExecutionStatus" ADD VALUE 'PAUSED';
ALTER TYPE "CampaignExecutionStatus" ADD VALUE 'PARTIAL';

-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'READY';
ALTER TYPE "CampaignStatus" ADD VALUE 'PAUSED';
ALTER TYPE "CampaignStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "CampaignStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "CampaignExecution" ADD COLUMN     "bulkMessageJobId" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "phase" "CampaignExecutionPhase" NOT NULL DEFAULT 'READY',
ADD COLUMN     "scrapeJobId" TEXT,
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "workerId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'READY';

-- CreateIndex
CREATE INDEX "CampaignExecution_userId_idx" ON "CampaignExecution"("userId");

-- CreateIndex
CREATE INDEX "CampaignExecution_phase_idx" ON "CampaignExecution"("phase");

-- CreateIndex
CREATE INDEX "CampaignExecution_workerId_idx" ON "CampaignExecution"("workerId");

-- CreateIndex
CREATE INDEX "CampaignExecution_leaseUntil_idx" ON "CampaignExecution"("leaseUntil");

-- AddForeignKey
ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_scrapeJobId_fkey" FOREIGN KEY ("scrapeJobId") REFERENCES "ScrapeJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_bulkMessageJobId_fkey" FOREIGN KEY ("bulkMessageJobId") REFERENCES "BulkMessageJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
