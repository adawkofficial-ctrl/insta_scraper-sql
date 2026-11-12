-- AlterEnum
ALTER TYPE "InstagramSenderStatus" ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE "InstagramSenderStatus" ADD VALUE IF NOT EXISTS 'WARMING';
ALTER TYPE "InstagramSenderStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "InstagramSenderStatus" ADD VALUE IF NOT EXISTS 'NEEDS_ATTENTION';

-- AlterTable
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "lastSentAt" TIMESTAMP(3);
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "sentToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "sentTodayDate" TEXT;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "sentThisHour" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "sentThisHourWindow" TEXT;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "totalSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "warmupStartedAt" TIMESTAMP(3);
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "pausedUntil" TIMESTAMP(3);
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "consecutiveErrors" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "dailyCap" INTEGER;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "hourlyCap" INTEGER;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "customMinGapSeconds" INTEGER;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "customMaxGapSeconds" INTEGER;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "workingHoursStart" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "InstagramSenderAccount" ADD COLUMN IF NOT EXISTS "workingHoursEnd" INTEGER NOT NULL DEFAULT 18;

-- CreateTable
CREATE TABLE IF NOT EXISTS "OutboundSendIdempotency" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT '1',
    "senderAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "messageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "contentHash" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundSendIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OutboundSendIdempotency_campaignId_leadId_step_key" ON "OutboundSendIdempotency"("campaignId", "leadId", "step");
CREATE INDEX IF NOT EXISTS "OutboundSendIdempotency_campaignId_leadId_idx" ON "OutboundSendIdempotency"("campaignId", "leadId");
CREATE INDEX IF NOT EXISTS "OutboundSendIdempotency_senderAccountId_idx" ON "OutboundSendIdempotency"("senderAccountId");
CREATE INDEX IF NOT EXISTS "OutboundSendIdempotency_status_idx" ON "OutboundSendIdempotency"("status");
CREATE INDEX IF NOT EXISTS "OutboundSendIdempotency_reservedAt_idx" ON "OutboundSendIdempotency"("reservedAt");

CREATE INDEX IF NOT EXISTS "InstagramSenderAccount_lastSentAt_idx" ON "InstagramSenderAccount"("lastSentAt");
CREATE INDEX IF NOT EXISTS "InstagramSenderAccount_pausedUntil_idx" ON "InstagramSenderAccount"("pausedUntil");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OutboundSendIdempotency_senderAccountId_fkey'
    ) THEN
        ALTER TABLE "OutboundSendIdempotency" ADD CONSTRAINT "OutboundSendIdempotency_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "InstagramSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
