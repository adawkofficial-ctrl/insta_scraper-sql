-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('LEAD_REPLIED', 'HIGH_VALUE_LEAD', 'SENDER_ERROR', 'SESSION_EXPIRED', 'SYSTEM_ERROR', 'DAILY_SUMMARY');

-- CreateEnum
CREATE TYPE "NotificationLogStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "NotificationConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ntfyTopic" TEXT NOT NULL,
    "ntfyServerUrl" TEXT NOT NULL DEFAULT 'https://ntfy.sh',
    "ntfyAccessToken" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "eventTypes" "NotificationEventType"[] DEFAULT ARRAY['LEAD_REPLIED', 'HIGH_VALUE_LEAD', 'SENDER_ERROR', 'SYSTEM_ERROR']::"NotificationEventType"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" "NotificationEventType" NOT NULL,
    "leadId" TEXT,
    "status" "NotificationLogStatus" NOT NULL,
    "errorReason" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationConfig_userId_key" ON "NotificationConfig"("userId");

-- CreateIndex
CREATE INDEX "NotificationLog_userId_createdAt_idx" ON "NotificationLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_eventType_createdAt_idx" ON "NotificationLog"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_leadId_idx" ON "NotificationLog"("leadId");

-- AddForeignKey
ALTER TABLE "NotificationConfig" ADD CONSTRAINT "NotificationConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
