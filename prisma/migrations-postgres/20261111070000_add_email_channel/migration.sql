-- Simple SMTP email channel.
ALTER TABLE "Lead" ADD COLUMN "emailSourceUrl" TEXT;
ALTER TABLE "Lead" ADD COLUMN "emailFoundAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "emailConfidence" DOUBLE PRECISION;
ALTER TABLE "Lead" ADD COLUMN "emailRole" TEXT;
ALTER TABLE "Lead" ADD COLUMN "emailInvalid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN "emailOptOutAt" TIMESTAMP(3);

CREATE TABLE "EmailSenderAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "postalAddress" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpUser" TEXT NOT NULL,
    "smtpPasswordEncrypted" TEXT NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dailyCap" INTEGER NOT NULL DEFAULT 15,
    "hourlyCap" INTEGER NOT NULL DEFAULT 4,
    "warmupStartedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "pausedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "dnsCheckedAt" TIMESTAMP(3),
    "spfStatus" TEXT,
    "dkimStatus" TEXT,
    "dmarcStatus" TEXT,
    "dkimSelector" TEXT,
    "allowDnsOverride" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailSenderAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailSenderAccount_userId_idx" ON "EmailSenderAccount"("userId");
CREATE INDEX "EmailSenderAccount_userId_status_idx" ON "EmailSenderAccount"("userId", "status");

CREATE TABLE "EmailCampaignSettings" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "subjectTemplate" TEXT NOT NULL DEFAULT '',
    "bodyTemplate" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailCampaignSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailCampaignSettings_campaignId_key" ON "EmailCampaignSettings"("campaignId");

CREATE TABLE "EmailSend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "senderAccountId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientDomain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "messageId" TEXT,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "senderIdentity" TEXT NOT NULL,
    "addressSource" TEXT,
    "addressFoundAt" TIMESTAMP(3),
    "addressConfidence" DOUBLE PRECISION,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "groupKey" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailSend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSend_leadId_key" ON "EmailSend"("leadId");
CREATE INDEX "EmailSend_campaignId_status_idx" ON "EmailSend"("campaignId", "status");
CREATE INDEX "EmailSend_senderAccountId_createdAt_idx" ON "EmailSend"("senderAccountId", "createdAt");
CREATE INDEX "EmailSend_recipientDomain_idx" ON "EmailSend"("recipientDomain");

CREATE TABLE "EmailUnsubscribeToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT,
    "emailNormalized" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailUnsubscribeToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailUnsubscribeToken_token_key" ON "EmailUnsubscribeToken"("token");
CREATE INDEX "EmailUnsubscribeToken_leadId_idx" ON "EmailUnsubscribeToken"("leadId");

ALTER TABLE "EmailSenderAccount" ADD CONSTRAINT "EmailSenderAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailCampaignSettings" ADD CONSTRAINT "EmailCampaignSettings_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "EmailSenderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
