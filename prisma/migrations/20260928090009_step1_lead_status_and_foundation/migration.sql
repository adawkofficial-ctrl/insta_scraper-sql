-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFYING', 'QUALIFIED', 'READY_FOR_OUTREACH', 'QUEUED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'FOLLOW_UP', 'MEETING', 'CONVERTED', 'NOT_INTERESTED', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "AiStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DncChannel" AS ENUM ('INSTAGRAM', 'EMAIL', 'ALL');

-- CreateEnum
CREATE TYPE "DncIdentifierType" AS ENUM ('USERNAME', 'INSTAGRAM_ID', 'EMAIL', 'DOMAIN');

-- CreateEnum
CREATE TYPE "DncSource" AS ENUM ('MANUAL', 'REPLY_OPT_OUT', 'UNSUBSCRIBE', 'IMPORT');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('INSTAGRAM', 'EMAIL');

-- CreateEnum
CREATE TYPE "UsageProvider" AS ENUM ('SPARIOR', 'APIFY', 'GEMINI', 'ZAPIER', 'OTHER');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "aiAnalysis" JSONB,
ADD COLUMN     "aiAnalyzedAt" TIMESTAMP(3),
ADD COLUMN     "aiFailedReason" TEXT,
ADD COLUMN     "aiStatus" "AiStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "emailNormalized" TEXT,
ADD COLUMN     "instagramUserId" TEXT,
ADD COLUMN     "lastContactedAt" TIMESTAMP(3),
ADD COLUMN     "leadQuality" TEXT,
ADD COLUMN     "leadScore" INTEGER,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "website" TEXT,
ADD COLUMN     "websiteDomain" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "aiAnalysis" JSONB,
ADD COLUMN     "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "channel" "MessageChannel" NOT NULL DEFAULT 'INSTAGRAM',
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "direction" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
ADD COLUMN     "intent" TEXT,
ADD COLUMN     "interestLevel" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "requiresHuman" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LeadStatusHistory" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoNotContact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "DncChannel" NOT NULL,
    "identifierType" "DncIdentifierType" NOT NULL,
    "identifierNormalized" TEXT NOT NULL,
    "reason" TEXT,
    "source" "DncSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoNotContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT,
    "senderAccountId" TEXT,
    "channel" "MessageChannel" NOT NULL,
    "externalThreadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requiresHuman" BOOLEAN NOT NULL DEFAULT false,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "campaignId" TEXT,
    "provider" "UsageProvider" NOT NULL,
    "operation" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "itemsReturned" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(12,6),
    "quotaRemaining" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadStatusHistory_leadId_createdAt_idx" ON "LeadStatusHistory"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "DoNotContact_identifierNormalized_idx" ON "DoNotContact"("identifierNormalized");

-- CreateIndex
CREATE INDEX "DoNotContact_userId_idx" ON "DoNotContact"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DoNotContact_userId_channel_identifierType_identifierNormal_key" ON "DoNotContact"("userId", "channel", "identifierType", "identifierNormalized");

-- CreateIndex
CREATE INDEX "Conversation_userId_requiresHuman_idx" ON "Conversation"("userId", "requiresHuman");

-- CreateIndex
CREATE INDEX "Conversation_lastInboundAt_idx" ON "Conversation"("lastInboundAt");

-- CreateIndex
CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");

-- CreateIndex
CREATE INDEX "Conversation_campaignId_idx" ON "Conversation"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_leadId_channel_key" ON "Conversation"("leadId", "channel");

-- CreateIndex
CREATE INDEX "UsageLog_provider_createdAt_idx" ON "UsageLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLog_campaignId_createdAt_idx" ON "UsageLog"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLog_userId_createdAt_idx" ON "UsageLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_campaignId_status_idx" ON "Lead"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Lead_instagramUserId_idx" ON "Lead"("instagramUserId");

-- CreateIndex
CREATE INDEX "Lead_emailNormalized_idx" ON "Lead"("emailNormalized");

-- CreateIndex
CREATE INDEX "Lead_websiteDomain_idx" ON "Lead"("websiteDomain");

-- CreateIndex
CREATE INDEX "Lead_leadScore_idx" ON "Lead"("leadScore");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusHistory" ADD CONSTRAINT "LeadStatusHistory_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoNotContact" ADD CONSTRAINT "DoNotContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "InstagramSenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
