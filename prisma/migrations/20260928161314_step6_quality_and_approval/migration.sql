-- CreateEnum
CREATE TYPE "DraftReviewAction" AS ENUM ('APPROVE', 'REJECT', 'EDIT', 'REGENERATE', 'RECHECK', 'OVERRIDE_WARNING', 'AUTO_APPROVE', 'REVOKE_APPROVAL');

-- CreateEnum
CREATE TYPE "RejectReason" AS ENUM ('TOO_GENERIC', 'WRONG_FACT', 'TOO_SALESY', 'BAD_TONE', 'NOT_TARGET', 'TOO_LONG', 'OTHER');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('MANUAL', 'AUTO_ELIGIBLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DraftStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "DraftStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "BulkMessageItem" ADD COLUMN     "bodyHash" TEXT,
ADD COLUMN     "draftId" TEXT,
ADD COLUMN     "renderedBody" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "approvalMode" "ApprovalMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "autoApproveMinScore" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "qualityMaxRegenerations" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "requireApproval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "draftId" TEXT;

-- AlterTable
ALTER TABLE "MessageDraft" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBodyHash" TEXT,
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedByType" TEXT,
ADD COLUMN     "bodyHash" TEXT,
ADD COLUMN     "editDistance" INTEGER,
ADD COLUMN     "editedBody" TEXT,
ADD COLUMN     "qualityCheckedAt" TIMESTAMP(3),
ADD COLUMN     "qualityPassed" BOOLEAN,
ADD COLUMN     "qualityResult" JSONB,
ADD COLUMN     "qualityScore" INTEGER,
ADD COLUMN     "qualityVersion" TEXT,
ADD COLUMN     "regenerationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rejectNotes" TEXT,
ADD COLUMN     "rejectReasonCode" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "warningOverrides" JSONB;

-- CreateTable
CREATE TABLE "DraftReview" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" "DraftReviewAction" NOT NULL,
    "reasonCode" TEXT,
    "notes" TEXT,
    "meta" JSONB,
    "bodyHashBefore" TEXT,
    "bodyHashAfter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DraftReview_draftId_createdAt_idx" ON "DraftReview"("draftId", "createdAt");

-- CreateIndex
CREATE INDEX "DraftReview_userId_idx" ON "DraftReview"("userId");

-- CreateIndex
CREATE INDEX "BulkMessageItem_draftId_idx" ON "BulkMessageItem"("draftId");

-- CreateIndex
CREATE INDEX "Message_draftId_idx" ON "Message"("draftId");

-- CreateIndex
CREATE INDEX "MessageDraft_qualityPassed_idx" ON "MessageDraft"("qualityPassed");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "MessageDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftReview" ADD CONSTRAINT "DraftReview_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "MessageDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftReview" ADD CONSTRAINT "DraftReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
