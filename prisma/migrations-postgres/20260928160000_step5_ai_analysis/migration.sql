-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'SENT');

-- CreateEnum
CREATE TYPE "AiAnalysisJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "aiInstructions" TEXT,
ADD COLUMN     "aiQualificationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "companyProfileId" TEXT,
ADD COLUMN     "messageLanguage" TEXT,
ADD COLUMN     "minLeadScore" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "targetNiche" TEXT;

-- CreateTable
CREATE TABLE "CompanyProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "services" JSONB NOT NULL DEFAULT '[]',
    "targetIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idealCustomerProfile" TEXT,
    "brandTone" TEXT,
    "messageLanguage" TEXT NOT NULL DEFAULT 'en',
    "preferredLength" JSONB,
    "ctaStyle" TEXT,
    "forbiddenClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricingPolicy" TEXT,
    "exampleMessages" JSONB,
    "objectionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "subject" TEXT,
    "channel" "MessageChannel" NOT NULL DEFAULT 'INSTAGRAM',
    "status" "DraftStatus" NOT NULL DEFAULT 'DRAFT',
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "personalizationPointsUsed" JSONB,
    "generationMeta" JSONB,
    "wordCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAnalysisJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "AiAnalysisJobStatus" NOT NULL DEFAULT 'PENDING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyProfile_userId_key" ON "CompanyProfile"("userId");

-- CreateIndex
CREATE INDEX "CompanyProfile_userId_idx" ON "CompanyProfile"("userId");

-- CreateIndex
CREATE INDEX "MessageDraft_leadId_createdAt_idx" ON "MessageDraft"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageDraft_campaignId_status_idx" ON "MessageDraft"("campaignId", "status");

-- CreateIndex
CREATE INDEX "MessageDraft_userId_createdAt_idx" ON "MessageDraft"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysisJob_campaignId_createdAt_idx" ON "AiAnalysisJob"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysisJob_userId_createdAt_idx" ON "AiAnalysisJob"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_companyProfileId_fkey" FOREIGN KEY ("companyProfileId") REFERENCES "CompanyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProfile" ADD CONSTRAINT "CompanyProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDraft" ADD CONSTRAINT "MessageDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDraft" ADD CONSTRAINT "MessageDraft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDraft" ADD CONSTRAINT "MessageDraft_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAnalysisJob" ADD CONSTRAINT "AiAnalysisJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAnalysisJob" ADD CONSTRAINT "AiAnalysisJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
