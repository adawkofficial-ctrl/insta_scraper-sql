-- CreateEnum
CREATE TYPE "InstagramSenderSessionType" AS ENUM ('PERSISTENT_PROFILE', 'STORAGE_STATE');

-- CreateEnum
CREATE TYPE "InstagramSenderStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'AUTH_REQUIRED', 'EXPIRED', 'ERROR', 'DISCONNECTED');

-- AlterTable
ALTER TABLE "BulkMessageJob" ADD COLUMN     "senderAccountId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "senderAccountId" TEXT;

-- AlterTable
ALTER TABLE "MessageAttempt" ADD COLUMN     "senderAccountId" TEXT;

-- CreateTable
CREATE TABLE "InstagramSenderAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "sessionType" "InstagramSenderSessionType" NOT NULL DEFAULT 'PERSISTENT_PROFILE',
    "sessionPath" TEXT NOT NULL,
    "status" "InstagramSenderStatus" NOT NULL DEFAULT 'CONNECTING',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramSenderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstagramSenderAccount_userId_idx" ON "InstagramSenderAccount"("userId");

-- CreateIndex
CREATE INDEX "InstagramSenderAccount_status_idx" ON "InstagramSenderAccount"("status");

-- CreateIndex
CREATE INDEX "InstagramSenderAccount_createdAt_idx" ON "InstagramSenderAccount"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramSenderAccount_userId_username_key" ON "InstagramSenderAccount"("userId", "username");

-- CreateIndex
CREATE INDEX "BulkMessageJob_senderAccountId_idx" ON "BulkMessageJob"("senderAccountId");

-- CreateIndex
CREATE INDEX "Message_senderAccountId_idx" ON "Message"("senderAccountId");

-- CreateIndex
CREATE INDEX "MessageAttempt_senderAccountId_idx" ON "MessageAttempt"("senderAccountId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "InstagramSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramSenderAccount" ADD CONSTRAINT "InstagramSenderAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkMessageJob" ADD CONSTRAINT "BulkMessageJob_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "InstagramSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "InstagramSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
