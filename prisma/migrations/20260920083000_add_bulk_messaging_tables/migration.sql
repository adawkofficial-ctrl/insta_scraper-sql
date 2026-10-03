-- CreateEnum
CREATE TYPE "BulkMessageJobStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BulkMessageItemStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "BulkMessageJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "BulkMessageJobStatus" NOT NULL DEFAULT 'DRAFT',
    "total" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "processing" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkMessageJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkMessageItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "renderedMessage" TEXT NOT NULL,
    "status" "BulkMessageItemStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "providerMessageId" TEXT,
    "idempotencyKey" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkMessageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "jobId" TEXT,
    "itemId" TEXT,
    "messageId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "status" "MessageStatus" NOT NULL DEFAULT 'SENDING',
    "messageText" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'playwright',
    "providerMessageId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "contentHash" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkMessageJob_campaignId_idx" ON "BulkMessageJob"("campaignId");

-- CreateIndex
CREATE INDEX "BulkMessageJob_userId_idx" ON "BulkMessageJob"("userId");

-- CreateIndex
CREATE INDEX "BulkMessageJob_status_idx" ON "BulkMessageJob"("status");

-- CreateIndex
CREATE INDEX "BulkMessageJob_createdAt_idx" ON "BulkMessageJob"("createdAt");

-- CreateIndex
CREATE INDEX "BulkMessageItem_jobId_idx" ON "BulkMessageItem"("jobId");

-- CreateIndex
CREATE INDEX "BulkMessageItem_leadId_idx" ON "BulkMessageItem"("leadId");

-- CreateIndex
CREATE INDEX "BulkMessageItem_status_idx" ON "BulkMessageItem"("status");

-- CreateIndex
CREATE INDEX "BulkMessageItem_idempotencyKey_idx" ON "BulkMessageItem"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BulkMessageItem_contentHash_idx" ON "BulkMessageItem"("contentHash");

-- CreateIndex
CREATE INDEX "BulkMessageItem_createdAt_idx" ON "BulkMessageItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkMessageItem_jobId_leadId_key" ON "BulkMessageItem"("jobId", "leadId");

-- CreateIndex
CREATE INDEX "MessageAttempt_leadId_idx" ON "MessageAttempt"("leadId");

-- CreateIndex
CREATE INDEX "MessageAttempt_campaignId_idx" ON "MessageAttempt"("campaignId");

-- CreateIndex
CREATE INDEX "MessageAttempt_userId_idx" ON "MessageAttempt"("userId");

-- CreateIndex
CREATE INDEX "MessageAttempt_jobId_idx" ON "MessageAttempt"("jobId");

-- CreateIndex
CREATE INDEX "MessageAttempt_itemId_idx" ON "MessageAttempt"("itemId");

-- CreateIndex
CREATE INDEX "MessageAttempt_messageId_idx" ON "MessageAttempt"("messageId");

-- CreateIndex
CREATE INDEX "MessageAttempt_status_idx" ON "MessageAttempt"("status");

-- CreateIndex
CREATE INDEX "MessageAttempt_idempotencyKey_idx" ON "MessageAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MessageAttempt_contentHash_idx" ON "MessageAttempt"("contentHash");

-- CreateIndex
CREATE INDEX "MessageAttempt_createdAt_idx" ON "MessageAttempt"("createdAt");

-- AddForeignKey
ALTER TABLE "BulkMessageJob" ADD CONSTRAINT "BulkMessageJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkMessageJob" ADD CONSTRAINT "BulkMessageJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkMessageJob" ADD CONSTRAINT "BulkMessageJob_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkMessageItem" ADD CONSTRAINT "BulkMessageItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkMessageJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkMessageItem" ADD CONSTRAINT "BulkMessageItem_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkMessageJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "BulkMessageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
