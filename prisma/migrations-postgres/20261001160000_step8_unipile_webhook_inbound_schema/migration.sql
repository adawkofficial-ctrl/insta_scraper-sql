-- Step 8: Unipile Webhooks, Inbound Messaging, and ConnectionMethod Schema

-- 1. Create Enums
CREATE TYPE "ConnectionMethod" AS ENUM ('PLAYWRIGHT', 'UNIPILE');
CREATE TYPE "UnipileWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- 2. Alter InstagramSenderAccount
ALTER TABLE "InstagramSenderAccount" ADD COLUMN "connectionMethod" "ConnectionMethod" NOT NULL DEFAULT 'PLAYWRIGHT';
ALTER TABLE "InstagramSenderAccount" ADD COLUMN "unipileAccountId" TEXT;

-- 3. Alter Message
ALTER TABLE "Message" ADD COLUMN "unipileMessageId" TEXT;
ALTER TABLE "Message" ADD COLUMN "unipileChatId" TEXT;

-- 4. Alter Conversation
ALTER TABLE "Conversation" ADD COLUMN "unipileChatId" TEXT;

-- 5. Create UnipileWebhookEvent
CREATE TABLE "UnipileWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "unipileEventId" TEXT,
    "rawPayloadHash" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "status" "UnipileWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnipileWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- 6. Create UnmatchedInboundMessage
CREATE TABLE "UnmatchedInboundMessage" (
    "id" TEXT NOT NULL,
    "unipileAccountId" TEXT NOT NULL,
    "unipileMessageId" TEXT,
    "unipileChatId" TEXT,
    "providerSenderId" TEXT NOT NULL,
    "username" TEXT,
    "text" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnmatchedInboundMessage_pkey" PRIMARY KEY ("id")
);

-- 7. Data migration: backfill connectionMethod and unipileAccountId for existing sender accounts
UPDATE "InstagramSenderAccount"
SET "connectionMethod" = 'UNIPILE'
WHERE "sessionPath" LIKE 'unipile:%';

WITH ranked AS (
  SELECT id,
         replace("sessionPath", 'unipile:', '') AS extracted_id,
         ROW_NUMBER() OVER (
           PARTITION BY replace("sessionPath", 'unipile:', '')
           ORDER BY
             CASE WHEN status = 'CONNECTED' THEN 0 ELSE 1 END,
             CASE WHEN "userId" = 'cmulfltch0000zwi05b3cd2gh' THEN 0 ELSE 1 END,
             "createdAt" DESC
         ) as rn
  FROM "InstagramSenderAccount"
  WHERE "sessionPath" LIKE 'unipile:%'
)
UPDATE "InstagramSenderAccount" a
SET "unipileAccountId" = CASE
  WHEN r.rn = 1 THEN r.extracted_id
  ELSE r.extracted_id || '_migrated_' || a.id
END
FROM ranked r
WHERE a.id = r.id;

-- 8. Create Unique and Secondary Indexes
CREATE UNIQUE INDEX "InstagramSenderAccount_unipileAccountId_key" ON "InstagramSenderAccount"("unipileAccountId");
CREATE INDEX "InstagramSenderAccount_connectionMethod_idx" ON "InstagramSenderAccount"("connectionMethod");
CREATE INDEX "InstagramSenderAccount_unipileAccountId_idx" ON "InstagramSenderAccount"("unipileAccountId");

CREATE UNIQUE INDEX "Message_unipileMessageId_key" ON "Message"("unipileMessageId");
CREATE INDEX "Message_unipileChatId_idx" ON "Message"("unipileChatId");

CREATE UNIQUE INDEX "Conversation_unipileChatId_key" ON "Conversation"("unipileChatId");
CREATE INDEX "Conversation_unipileChatId_idx" ON "Conversation"("unipileChatId");

CREATE UNIQUE INDEX "UnipileWebhookEvent_unipileEventId_key" ON "UnipileWebhookEvent"("unipileEventId");
CREATE INDEX "UnipileWebhookEvent_rawPayloadHash_idx" ON "UnipileWebhookEvent"("rawPayloadHash");
CREATE INDEX "UnipileWebhookEvent_eventType_status_idx" ON "UnipileWebhookEvent"("eventType", "status");
CREATE INDEX "UnipileWebhookEvent_createdAt_idx" ON "UnipileWebhookEvent"("createdAt");

CREATE UNIQUE INDEX "UnmatchedInboundMessage_unipileMessageId_key" ON "UnmatchedInboundMessage"("unipileMessageId");
CREATE INDEX "UnmatchedInboundMessage_unipileAccountId_idx" ON "UnmatchedInboundMessage"("unipileAccountId");
CREATE INDEX "UnmatchedInboundMessage_providerSenderId_idx" ON "UnmatchedInboundMessage"("providerSenderId");
CREATE INDEX "UnmatchedInboundMessage_username_idx" ON "UnmatchedInboundMessage"("username");
CREATE INDEX "UnmatchedInboundMessage_linkedLeadId_idx" ON "UnmatchedInboundMessage"("linkedLeadId");
