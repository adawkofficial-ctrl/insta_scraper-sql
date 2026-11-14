-- CreateEnum
CREATE TYPE "ReplyIntent" AS ENUM ('INTERESTED', 'PRICE_REQUEST', 'MEETING_REQUEST', 'QUESTION', 'NOT_INTERESTED', 'OUT_OF_OFFICE', 'FOLLOW_UP_LATER', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('OUTREACH', 'REPLY');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "classificationPromptVersion" TEXT,
ADD COLUMN     "classifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MessageDraft" ADD COLUMN     "kind" "DraftKind" NOT NULL DEFAULT 'OUTREACH',
ADD COLUMN     "replyToMessageId" TEXT;

-- CreateIndex
CREATE INDEX "Message_intent_idx" ON "Message"("intent");

-- CreateIndex
CREATE INDEX "Message_classifiedAt_idx" ON "Message"("classifiedAt");

-- CreateIndex
CREATE INDEX "MessageDraft_kind_idx" ON "MessageDraft"("kind");

-- CreateIndex
CREATE INDEX "MessageDraft_replyToMessageId_idx" ON "MessageDraft"("replyToMessageId");

-- AddForeignKey
ALTER TABLE "MessageDraft" ADD CONSTRAINT "MessageDraft_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
