-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('SCHEDULED', 'SENT', 'CANCELLED_REPLIED', 'CANCELLED_DNC', 'CANCELLED_MANUAL', 'NEEDS_EDIT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "followUpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "followUpCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "followUpDelayDays" INTEGER[] DEFAULT ARRAY[3, 5]::INTEGER[],
ADD COLUMN "followUpTemplates" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "FollowUpMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'SCHEDULED',
    "templateText" TEXT NOT NULL,
    "renderedBody" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "threadId" TEXT,
    "messageId" TEXT,
    "senderAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpMessage_idempotencyKey_key" ON "FollowUpMessage"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpMessage_campaignId_leadId_step_key" ON "FollowUpMessage"("campaignId", "leadId", "step");

-- CreateIndex
CREATE INDEX "FollowUpMessage_status_dueAt_idx" ON "FollowUpMessage"("status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUpMessage_campaignId_status_idx" ON "FollowUpMessage"("campaignId", "status");

-- CreateIndex
CREATE INDEX "FollowUpMessage_leadId_idx" ON "FollowUpMessage"("leadId");

-- AddForeignKey
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
