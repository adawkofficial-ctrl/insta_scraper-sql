-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `image` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'USER',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    INDEX `User_email_idx`(`email`),
    INDEX `User_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Campaign` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `executionMode` ENUM('MANUAL', 'REVIEW_REQUIRED') NOT NULL DEFAULT 'MANUAL',
    `messageApprovalRequired` BOOLEAN NOT NULL DEFAULT true,
    `scheduledAt` DATETIME(3) NULL,
    `intent` TEXT NULL,
    `location` VARCHAR(1000) NULL,
    `category` VARCHAR(191) NULL,
    `leadLimit` INTEGER NULL,
    `followUpEnabled` BOOLEAN NOT NULL DEFAULT false,
    `followUpCount` INTEGER NOT NULL DEFAULT 1,
    `followUpDelayDays` JSON NULL,
    `followUpTemplates` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `companyProfileId` VARCHAR(191) NOT NULL,
    `aiQualificationEnabled` BOOLEAN NOT NULL DEFAULT false,
    `minLeadScore` INTEGER NOT NULL DEFAULT 60,
    `aiInstructions` TEXT NULL,
    `targetNiche` VARCHAR(191) NULL,
    `messageLanguage` VARCHAR(191) NULL,
    `requireApproval` BOOLEAN NOT NULL DEFAULT true,
    `approvalMode` ENUM('MANUAL', 'AUTO_ELIGIBLE') NOT NULL DEFAULT 'MANUAL',
    `autoApproveMinScore` INTEGER NOT NULL DEFAULT 80,
    `qualityMaxRegenerations` INTEGER NOT NULL DEFAULT 2,
    `customNegativeKeywords` JSON NULL,
    `customPositiveKeywords` JSON NULL,
    `minRating` DOUBLE NULL,
    `minReviews` INTEGER NULL,
    `excludeChains` BOOLEAN NOT NULL DEFAULT true,
    `autoOptimize` BOOLEAN NOT NULL DEFAULT false,
    `explorationBudgetShare` DOUBLE NOT NULL DEFAULT 0.15,

    INDEX `Campaign_userId_idx`(`userId`),
    INDEX `Campaign_status_idx`(`status`),
    INDEX `Campaign_executionMode_idx`(`executionMode`),
    INDEX `Campaign_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Lead` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NULL,
    `instagramUsername` VARCHAR(191) NULL,
    `profileUrl` VARCHAR(512) NULL,
    `fullName` VARCHAR(255) NULL,
    `biography` LONGTEXT NULL,
    `followers` INTEGER NULL,
    `following` INTEGER NULL,
    `postsCount` INTEGER NULL,
    `profilePictureUrl` VARCHAR(191) NULL,
    `profilePicUrl` VARCHAR(191) NULL,
    `profilePicUrlHD` VARCHAR(191) NULL,
    `isVerified` BOOLEAN NULL,
    `verified` BOOLEAN NULL,
    `isBusiness` BOOLEAN NULL,
    `isBusinessAccount` BOOLEAN NULL,
    `category` VARCHAR(191) NULL,
    `businessCategoryName` VARCHAR(191) NULL,
    `externalUrl` TEXT NULL,
    `instagramId` VARCHAR(191) NULL,
    `location` TEXT NULL,
    `followersCount` INTEGER NULL,
    `followsCount` INTEGER NULL,
    `relatedProfiles` JSON NULL,
    `latestPosts` JSON NULL,
    `rawProfileData` JSON NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'apify',
    `scrapedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `status` ENUM('NEW', 'ENRICH_PENDING', 'QUALIFYING', 'QUALIFIED', 'READY_FOR_OUTREACH', 'QUEUED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'FOLLOW_UP', 'MEETING', 'CONVERTED', 'NOT_INTERESTED', 'DO_NOT_CONTACT') NOT NULL DEFAULT 'NEW',
    `statusUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `instagramUserId` VARCHAR(191) NULL,
    `email` VARCHAR(254) NULL,
    `emailNormalized` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `phoneNormalized` VARCHAR(191) NULL,
    `website` TEXT NULL,
    `websiteDomain` VARCHAR(191) NULL,
    `socialLink` VARCHAR(191) NULL,
    `socialPlatform` VARCHAR(191) NULL,
    `contactSource` VARCHAR(191) NULL,
    `emailSourceUrl` TEXT NULL,
    `emailFoundAt` DATETIME(3) NULL,
    `emailConfidence` DOUBLE NULL,
    `emailRole` VARCHAR(191) NULL,
    `emailInvalid` BOOLEAN NOT NULL DEFAULT false,
    `emailOptOutAt` DATETIME(3) NULL,
    `hasInstagram` BOOLEAN NOT NULL DEFAULT false,
    `hasEmail` BOOLEAN NOT NULL DEFAULT false,
    `hasPhone` BOOLEAN NOT NULL DEFAULT false,
    `hasWebsite` BOOLEAN NOT NULL DEFAULT false,
    `hasOtherSocial` BOOLEAN NOT NULL DEFAULT false,
    `leadScore` INTEGER NULL,
    `leadQuality` VARCHAR(191) NULL,
    `aiStatus` ENUM('PENDING', 'DONE', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `aiAnalysis` JSON NULL,
    `aiAnalyzedAt` DATETIME(3) NULL,
    `aiFailedReason` TEXT NULL,
    `promptVersion` VARCHAR(191) NULL,
    `lastContactedAt` DATETIME(3) NULL,
    `userId` VARCHAR(191) NULL,
    `usernameNormalized` VARCHAR(191) NULL,
    `profileUrlCanonical` TEXT NULL,
    `websiteKey` VARCHAR(191) NULL,
    `previousUsernames` JSON NULL,
    `duplicateOfLeadId` VARCHAR(191) NULL,
    `dedupMatchedBy` VARCHAR(191) NULL,
    `dedupFlaggedAt` DATETIME(3) NULL,
    `possibleDuplicateOfLeadId` VARCHAR(191) NULL,
    `possibleDuplicateReason` VARCHAR(191) NULL,
    `activeInstagramGuard` VARCHAR(191) NULL,
    `activeUsernameGuard` VARCHAR(191) NULL,
    `activeEmailGuard` VARCHAR(191) NULL,
    `gmapsPlaceId` VARCHAR(191) NULL,
    `rating` DOUBLE NULL,
    `reviewCount` INTEGER NULL,
    `city` VARCHAR(191) NULL,
    `handleSource` VARCHAR(191) NULL,
    `handleConfidence` VARCHAR(191) NULL,
    `qualityScore` INTEGER NULL,
    `qualityTier` VARCHAR(191) NULL,
    `scoreBreakdown` JSON NULL,
    `isChain` BOOLEAN NOT NULL DEFAULT false,
    `isClaimed` BOOLEAN NULL,
    `lastPostAt` DATETIME(3) NULL,
    `scoreVersion` INTEGER NOT NULL DEFAULT 1,
    `scrapeJobId` VARCHAR(191) NULL,
    `discoveryKeyword` VARCHAR(191) NULL,
    `discoveryCity` VARCHAR(191) NULL,
    `acquisitionCostUsd` DECIMAL(10, 4) NULL,
    `acquisitionCostBreakdown` JSON NULL,
    `messageVariant` VARCHAR(191) NULL,
    `isDryRun` BOOLEAN NOT NULL DEFAULT false,
    `isGroup` BOOLEAN NOT NULL DEFAULT false,
    `groupKey` VARCHAR(191) NULL,
    `lastHandleEnrichmentAt` DATETIME(3) NULL,

    INDEX `Lead_hasInstagram_idx`(`hasInstagram`),
    INDEX `Lead_hasEmail_idx`(`hasEmail`),
    INDEX `Lead_hasPhone_idx`(`hasPhone`),
    INDEX `Lead_hasWebsite_idx`(`hasWebsite`),
    INDEX `Lead_hasOtherSocial_idx`(`hasOtherSocial`),
    INDEX `Lead_campaignId_idx`(`campaignId`),
    INDEX `Lead_username_idx`(`username`),
    INDEX `Lead_profileUrl_idx`(`profileUrl`),
    INDEX `Lead_fullName_idx`(`fullName`),
    INDEX `Lead_category_idx`(`category`),
    INDEX `Lead_createdAt_idx`(`createdAt`),
    INDEX `Lead_status_idx`(`status`),
    INDEX `Lead_campaignId_status_idx`(`campaignId`, `status`),
    INDEX `Lead_instagramUserId_idx`(`instagramUserId`),
    INDEX `Lead_emailNormalized_idx`(`emailNormalized`),
    INDEX `Lead_phoneNormalized_idx`(`phoneNormalized`),
    INDEX `Lead_websiteDomain_idx`(`websiteDomain`),
    INDEX `Lead_leadScore_idx`(`leadScore`),
    INDEX `Lead_userId_idx`(`userId`),
    INDEX `Lead_userId_usernameNormalized_idx`(`userId`, `usernameNormalized`),
    INDEX `Lead_userId_instagramUserId_idx`(`userId`, `instagramUserId`),
    INDEX `Lead_userId_emailNormalized_idx`(`userId`, `emailNormalized`),
    INDEX `Lead_userId_websiteKey_idx`(`userId`, `websiteKey`),
    INDEX `Lead_duplicateOfLeadId_idx`(`duplicateOfLeadId`),
    INDEX `Lead_possibleDuplicateOfLeadId_idx`(`possibleDuplicateOfLeadId`),
    INDEX `Lead_gmapsPlaceId_idx`(`gmapsPlaceId`),
    INDEX `Lead_userId_gmapsPlaceId_idx`(`userId`, `gmapsPlaceId`),
    INDEX `Lead_qualityScore_idx`(`qualityScore`),
    INDEX `Lead_qualityTier_idx`(`qualityTier`),
    INDEX `Lead_scrapeJobId_idx`(`scrapeJobId`),
    INDEX `Lead_discoveryKeyword_idx`(`discoveryKeyword`),
    INDEX `Lead_discoveryCity_idx`(`discoveryCity`),
    INDEX `Lead_isDryRun_idx`(`isDryRun`),
    INDEX `Lead_campaignId_isDryRun_idx`(`campaignId`, `isDryRun`),
    INDEX `Lead_groupKey_idx`(`groupKey`),
    INDEX `Lead_campaignId_groupKey_idx`(`campaignId`, `groupKey`),
    INDEX `Lead_messageVariant_idx`(`messageVariant`),
    UNIQUE INDEX `Lead_campaignId_username_key`(`campaignId`, `username`),
    UNIQUE INDEX `Lead_userId_activeInstagramGuard_key`(`userId`, `activeInstagramGuard`),
    UNIQUE INDEX `Lead_userId_activeUsernameGuard_key`(`userId`, `activeUsernameGuard`),
    UNIQUE INDEX `Lead_userId_activeEmailGuard_key`(`userId`, `activeEmailGuard`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadScoreFlag` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `flag` VARCHAR(191) NOT NULL,

    INDEX `LeadScoreFlag_flag_idx`(`flag`),
    UNIQUE INDEX `LeadScoreFlag_leadId_flag_key`(`leadId`, `flag`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadSighting` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `scrapeJobId` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL,
    `matchedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LeadSighting_leadId_idx`(`leadId`),
    INDEX `LeadSighting_campaignId_createdAt_idx`(`campaignId`, `createdAt`),
    INDEX `LeadSighting_scrapeJobId_idx`(`scrapeJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScrapeJob` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `provider` VARCHAR(191) NOT NULL,
    `inputCount` INTEGER NOT NULL DEFAULT 0,
    `processedCount` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `query` VARCHAR(191) NULL,
    `location` VARCHAR(191) NULL,
    `category` VARCHAR(191) NULL,
    `discoveryActor` VARCHAR(191) NULL,
    `enrichmentActor` VARCHAR(191) NULL,
    `requestedLimit` INTEGER NULL,
    `candidatesDiscovered` INTEGER NULL,
    `candidatesEnriched` INTEGER NULL,
    `candidatesSkipped` INTEGER NULL,
    `usage` JSON NULL,
    `stopReason` VARCHAR(191) NULL,
    `costUsd` DECIMAL(10, 4) NULL,
    `costBreakdown` JSON NULL,
    `isDryRun` BOOLEAN NOT NULL DEFAULT false,

    INDEX `ScrapeJob_campaignId_idx`(`campaignId`),
    INDEX `ScrapeJob_status_idx`(`status`),
    INDEX `ScrapeJob_createdAt_idx`(`createdAt`),
    INDEX `ScrapeJob_isDryRun_idx`(`isDryRun`),
    INDEX `ScrapeJob_campaignId_isDryRun_idx`(`campaignId`, `isDryRun`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DiscoveryCoverage` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NULL,
    `keyword` VARCHAR(191) NOT NULL,
    `area` VARCHAR(191) NOT NULL,
    `runDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `placeIds` JSON NOT NULL,
    `newPlaces` INTEGER NOT NULL DEFAULT 0,
    `acceptedLeads` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DiscoveryCoverage_userId_keyword_area_runDate_idx`(`userId`, `keyword`, `area`, `runDate`),
    INDEX `DiscoveryCoverage_userId_runDate_idx`(`userId`, `runDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DiscoveryPlaceOutcome` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `placeId` VARCHAR(191) NOT NULL,
    `outcome` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `keyword` VARCHAR(191) NULL,
    `area` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DiscoveryPlaceOutcome_userId_updatedAt_idx`(`userId`, `updatedAt`),
    UNIQUE INDEX `DiscoveryPlaceOutcome_userId_placeId_key`(`userId`, `placeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Candidate` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `scrapeJobId` VARCHAR(191) NULL,
    `runId` VARCHAR(191) NULL,
    `datasetId` VARCHAR(191) NULL,
    `costUsd` DECIMAL(10, 4) NULL,
    `placeId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `category` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `city` VARCHAR(191) NULL,
    `state` VARCHAR(191) NULL,
    `countryCode` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `website` TEXT NULL,
    `rating` DOUBLE NULL,
    `reviewsCount` INTEGER NULL,
    `mapsUrl` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'DISCOVERED',
    `rejectionReason` VARCHAR(191) NULL,
    `lastError` VARCHAR(191) NULL,
    `handle` VARCHAR(191) NULL,
    `handleSource` VARCHAR(191) NULL,
    `handleConfidence` VARCHAR(191) NULL,
    `socialLinks` JSON NULL,
    `rawPlaceData` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Candidate_campaignId_status_idx`(`campaignId`, `status`),
    INDEX `Candidate_scrapeJobId_idx`(`scrapeJobId`),
    INDEX `Candidate_placeId_idx`(`placeId`),
    UNIQUE INDEX `Candidate_campaignId_placeId_key`(`campaignId`, `placeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailSenderAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `fromName` VARCHAR(191) NOT NULL,
    `fromAddress` VARCHAR(191) NOT NULL,
    `postalAddress` VARCHAR(191) NOT NULL,
    `smtpHost` VARCHAR(191) NOT NULL,
    `smtpPort` INTEGER NOT NULL,
    `smtpUser` VARCHAR(191) NOT NULL,
    `smtpPasswordEncrypted` LONGTEXT NOT NULL,
    `secure` BOOLEAN NOT NULL DEFAULT true,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `dailyCap` INTEGER NOT NULL DEFAULT 15,
    `hourlyCap` INTEGER NOT NULL DEFAULT 4,
    `warmupStartedAt` DATETIME(3) NULL,
    `lastSentAt` DATETIME(3) NULL,
    `consecutiveErrors` INTEGER NOT NULL DEFAULT 0,
    `pausedUntil` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `dnsCheckedAt` DATETIME(3) NULL,
    `spfStatus` VARCHAR(191) NULL,
    `dkimStatus` VARCHAR(191) NULL,
    `dmarcStatus` VARCHAR(191) NULL,
    `dkimSelector` VARCHAR(191) NULL,
    `allowDnsOverride` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EmailSenderAccount_userId_idx`(`userId`),
    INDEX `EmailSenderAccount_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailCampaignSettings` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `subjectTemplate` VARCHAR(1000) NOT NULL,
    `bodyTemplate` LONGTEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `templateVersion` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EmailCampaignSettings_campaignId_key`(`campaignId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailSend` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NULL,
    `leadId` VARCHAR(191) NULL,
    `senderAccountId` VARCHAR(191) NOT NULL,
    `recipient` VARCHAR(254) NOT NULL,
    `recipientDomain` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'QUEUED',
    `subject` VARCHAR(255) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `messageId` VARCHAR(191) NULL,
    `templateVersion` INTEGER NOT NULL DEFAULT 1,
    `senderIdentity` VARCHAR(191) NOT NULL,
    `addressSource` VARCHAR(191) NULL,
    `addressFoundAt` DATETIME(3) NULL,
    `addressConfidence` DOUBLE NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `groupKey` VARCHAR(191) NULL,
    `isTest` BOOLEAN NOT NULL DEFAULT false,
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EmailSend_campaignId_status_idx`(`campaignId`, `status`),
    INDEX `EmailSend_senderAccountId_createdAt_idx`(`senderAccountId`, `createdAt`),
    INDEX `EmailSend_recipientDomain_idx`(`recipientDomain`),
    UNIQUE INDEX `EmailSend_leadId_key`(`leadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailUnsubscribeToken` (
    `id` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NULL,
    `emailNormalized` VARCHAR(191) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailUnsubscribeToken_token_key`(`token`),
    INDEX `EmailUnsubscribeToken_leadId_idx`(`leadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'playwright',
    `providerMessageId` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'DRAFT',
    `messageText` LONGTEXT NOT NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `contentHash` VARCHAR(64) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `draftId` VARCHAR(191) NULL,
    `unipileMessageId` VARCHAR(191) NULL,
    `unipileChatId` VARCHAR(191) NULL,
    `direction` ENUM('OUTBOUND', 'INBOUND') NOT NULL DEFAULT 'OUTBOUND',
    `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL DEFAULT 'INSTAGRAM',
    `conversationId` VARCHAR(191) NULL,
    `aiGenerated` BOOLEAN NOT NULL DEFAULT false,
    `promptVersion` VARCHAR(191) NULL,
    `receivedAt` DATETIME(3) NULL,
    `intent` VARCHAR(191) NULL,
    `interestLevel` VARCHAR(191) NULL,
    `requiresHuman` BOOLEAN NOT NULL DEFAULT false,
    `aiAnalysis` JSON NULL,
    `classifiedAt` DATETIME(3) NULL,
    `classificationPromptVersion` VARCHAR(191) NULL,
    `replyCategory` VARCHAR(191) NULL,

    UNIQUE INDEX `Message_unipileMessageId_key`(`unipileMessageId`),
    INDEX `Message_leadId_idx`(`leadId`),
    INDEX `Message_campaignId_idx`(`campaignId`),
    INDEX `Message_status_idx`(`status`),
    INDEX `Message_idempotencyKey_idx`(`idempotencyKey`),
    INDEX `Message_contentHash_idx`(`contentHash`),
    INDEX `Message_senderAccountId_idx`(`senderAccountId`),
    INDEX `Message_conversationId_idx`(`conversationId`),
    INDEX `Message_unipileChatId_idx`(`unipileChatId`),
    INDEX `Message_draftId_idx`(`draftId`),
    INDEX `Message_createdAt_idx`(`createdAt`),
    INDEX `Message_intent_idx`(`intent`),
    INDEX `Message_classifiedAt_idx`(`classifiedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MessageTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `variants` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MessageTemplate_campaignId_idx`(`campaignId`),
    INDEX `MessageTemplate_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InstagramSenderAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NULL,
    `connectionMethod` ENUM('PLAYWRIGHT', 'UNIPILE') NOT NULL DEFAULT 'PLAYWRIGHT',
    `unipileAccountId` VARCHAR(191) NULL,
    `sessionType` ENUM('PERSISTENT_PROFILE', 'STORAGE_STATE') NOT NULL DEFAULT 'PERSISTENT_PROFILE',
    `sessionPath` TEXT NOT NULL,
    `status` ENUM('CONNECTING', 'CONNECTED', 'AUTH_REQUIRED', 'EXPIRED', 'ERROR', 'DISCONNECTED', 'ACTIVE', 'WARMING', 'PAUSED', 'NEEDS_ATTENTION') NOT NULL DEFAULT 'CONNECTING',
    `lastVerifiedAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastSentAt` DATETIME(3) NULL,
    `sentToday` INTEGER NOT NULL DEFAULT 0,
    `sentTodayDate` VARCHAR(191) NULL,
    `sentThisHour` INTEGER NOT NULL DEFAULT 0,
    `sentThisHourWindow` VARCHAR(191) NULL,
    `totalSent` INTEGER NOT NULL DEFAULT 0,
    `warmupStartedAt` DATETIME(3) NULL,
    `pausedUntil` DATETIME(3) NULL,
    `lastErrorCode` VARCHAR(191) NULL,
    `consecutiveErrors` INTEGER NOT NULL DEFAULT 0,
    `dailyCap` INTEGER NULL,
    `hourlyCap` INTEGER NULL,
    `customMinGapSeconds` INTEGER NULL,
    `customMaxGapSeconds` INTEGER NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'UTC',
    `workingHoursStart` INTEGER NOT NULL DEFAULT 9,
    `workingHoursEnd` INTEGER NOT NULL DEFAULT 18,

    UNIQUE INDEX `InstagramSenderAccount_unipileAccountId_key`(`unipileAccountId`),
    INDEX `InstagramSenderAccount_userId_idx`(`userId`),
    INDEX `InstagramSenderAccount_status_idx`(`status`),
    INDEX `InstagramSenderAccount_connectionMethod_idx`(`connectionMethod`),
    INDEX `InstagramSenderAccount_unipileAccountId_idx`(`unipileAccountId`),
    INDEX `InstagramSenderAccount_createdAt_idx`(`createdAt`),
    INDEX `InstagramSenderAccount_lastSentAt_idx`(`lastSentAt`),
    INDEX `InstagramSenderAccount_pausedUntil_idx`(`pausedUntil`),
    UNIQUE INDEX `InstagramSenderAccount_userId_username_key`(`userId`, `username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboundSendIdempotency` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `step` VARCHAR(191) NOT NULL DEFAULT '1',
    `senderAccountId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'RESERVED',
    `messageId` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `contentHash` VARCHAR(191) NULL,
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OutboundSendIdempotency_campaignId_leadId_idx`(`campaignId`, `leadId`),
    INDEX `OutboundSendIdempotency_senderAccountId_idx`(`senderAccountId`),
    INDEX `OutboundSendIdempotency_status_idx`(`status`),
    INDEX `OutboundSendIdempotency_reservedAt_idx`(`reservedAt`),
    UNIQUE INDEX `OutboundSendIdempotency_campaignId_leadId_step_key`(`campaignId`, `leadId`, `step`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampaignExecution` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `status` ENUM('PREVIEW', 'DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'READY',
    `phase` ENUM('DISCOVERY', 'ENRICHMENT', 'READY', 'MESSAGING', 'FINALIZING') NOT NULL DEFAULT 'READY',
    `executionMode` ENUM('MANUAL', 'REVIEW_REQUIRED') NOT NULL DEFAULT 'MANUAL',
    `workerId` VARCHAR(191) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `heartbeatAt` DATETIME(3) NULL,
    `totalItems` INTEGER NOT NULL DEFAULT 0,
    `processedItems` INTEGER NOT NULL DEFAULT 0,
    `successfulItems` INTEGER NOT NULL DEFAULT 0,
    `failedItems` INTEGER NOT NULL DEFAULT 0,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `scrapeJobId` VARCHAR(191) NULL,
    `bulkMessageJobId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `pausedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CampaignExecution_campaignId_idx`(`campaignId`),
    INDEX `CampaignExecution_userId_idx`(`userId`),
    INDEX `CampaignExecution_status_idx`(`status`),
    INDEX `CampaignExecution_phase_idx`(`phase`),
    INDEX `CampaignExecution_workerId_idx`(`workerId`),
    INDEX `CampaignExecution_leaseUntil_idx`(`leaseUntil`),
    INDEX `CampaignExecution_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampaignExecutionItem` (
    `id` VARCHAR(191) NOT NULL,
    `executionId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'SENDING', 'SKIPPED', 'SENT', 'FAILED', 'SUPPRESSED_DNC') NOT NULL DEFAULT 'PENDING',
    `messageText` VARCHAR(191) NOT NULL,
    `errorMessage` VARCHAR(191) NULL,
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CampaignExecutionItem_executionId_idx`(`executionId`),
    INDEX `CampaignExecutionItem_leadId_idx`(`leadId`),
    INDEX `CampaignExecutionItem_status_idx`(`status`),
    INDEX `CampaignExecutionItem_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `CampaignExecutionItem_executionId_leadId_key`(`executionId`, `leadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BulkMessageJob` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `total` INTEGER NOT NULL DEFAULT 0,
    `queued` INTEGER NOT NULL DEFAULT 0,
    `processing` INTEGER NOT NULL DEFAULT 0,
    `sent` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `skipped` INTEGER NOT NULL DEFAULT 0,
    `cancelled` INTEGER NOT NULL DEFAULT 0,
    `unknown` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BulkMessageJob_campaignId_idx`(`campaignId`),
    INDEX `BulkMessageJob_userId_idx`(`userId`),
    INDEX `BulkMessageJob_status_idx`(`status`),
    INDEX `BulkMessageJob_senderAccountId_idx`(`senderAccountId`),
    INDEX `BulkMessageJob_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BulkMessageItem` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `renderedMessage` LONGTEXT NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED', 'UNKNOWN', 'SUPPRESSED_DNC') NOT NULL DEFAULT 'QUEUED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `contentHash` VARCHAR(64) NULL,
    `draftId` VARCHAR(191) NULL,
    `renderedBody` LONGTEXT NULL,
    `bodyHash` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BulkMessageItem_draftId_key`(`draftId`),
    INDEX `BulkMessageItem_jobId_idx`(`jobId`),
    INDEX `BulkMessageItem_leadId_idx`(`leadId`),
    INDEX `BulkMessageItem_status_idx`(`status`),
    INDEX `BulkMessageItem_idempotencyKey_idx`(`idempotencyKey`),
    INDEX `BulkMessageItem_contentHash_idx`(`contentHash`),
    INDEX `BulkMessageItem_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `BulkMessageItem_jobId_leadId_key`(`jobId`, `leadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MessageAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NULL,
    `itemId` VARCHAR(191) NULL,
    `messageId` VARCHAR(191) NULL,
    `direction` VARCHAR(191) NOT NULL DEFAULT 'OUTBOUND',
    `status` ENUM('DRAFT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'SENDING',
    `messageText` LONGTEXT NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'playwright',
    `providerMessageId` VARCHAR(191) NULL,
    `attemptNumber` INTEGER NOT NULL DEFAULT 1,
    `idempotencyKey` VARCHAR(191) NULL,
    `contentHash` VARCHAR(64) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `senderAccountId` VARCHAR(191) NULL,

    INDEX `MessageAttempt_leadId_idx`(`leadId`),
    INDEX `MessageAttempt_campaignId_idx`(`campaignId`),
    INDEX `MessageAttempt_userId_idx`(`userId`),
    INDEX `MessageAttempt_jobId_idx`(`jobId`),
    INDEX `MessageAttempt_itemId_idx`(`itemId`),
    INDEX `MessageAttempt_messageId_idx`(`messageId`),
    INDEX `MessageAttempt_status_idx`(`status`),
    INDEX `MessageAttempt_idempotencyKey_idx`(`idempotencyKey`),
    INDEX `MessageAttempt_contentHash_idx`(`contentHash`),
    INDEX `MessageAttempt_senderAccountId_idx`(`senderAccountId`),
    INDEX `MessageAttempt_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadStatusHistory` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `fromStatus` ENUM('NEW', 'ENRICH_PENDING', 'QUALIFYING', 'QUALIFIED', 'READY_FOR_OUTREACH', 'QUEUED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'FOLLOW_UP', 'MEETING', 'CONVERTED', 'NOT_INTERESTED', 'DO_NOT_CONTACT') NULL,
    `toStatus` ENUM('NEW', 'ENRICH_PENDING', 'QUALIFYING', 'QUALIFIED', 'READY_FOR_OUTREACH', 'QUEUED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'FOLLOW_UP', 'MEETING', 'CONVERTED', 'NOT_INTERESTED', 'DO_NOT_CONTACT') NOT NULL,
    `reason` VARCHAR(191) NULL,
    `actor` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LeadStatusHistory_leadId_createdAt_idx`(`leadId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DoNotContact` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `channel` ENUM('INSTAGRAM', 'EMAIL', 'PHONE', 'ALL') NOT NULL,
    `identifierType` ENUM('USERNAME', 'INSTAGRAM_ID', 'EMAIL', 'DOMAIN', 'PHONE') NOT NULL,
    `identifierNormalized` VARCHAR(320) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `source` ENUM('MANUAL', 'REPLY_OPT_OUT', 'UNSUBSCRIBE', 'IMPORT') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DoNotContact_identifierNormalized_idx`(`identifierNormalized`),
    INDEX `DoNotContact_userId_idx`(`userId`),
    UNIQUE INDEX `DoNotContact_userId_channel_identifierType_identifierNormali_key`(`userId`, `channel`, `identifierType`, `identifierNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Conversation` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL,
    `externalThreadId` VARCHAR(191) NULL,
    `unipileChatId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `requiresHuman` BOOLEAN NOT NULL DEFAULT false,
    `unreadCount` INTEGER NOT NULL DEFAULT 0,
    `lastMessageAt` DATETIME(3) NULL,
    `lastInboundAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Conversation_unipileChatId_key`(`unipileChatId`),
    INDEX `Conversation_userId_requiresHuman_idx`(`userId`, `requiresHuman`),
    INDEX `Conversation_lastInboundAt_idx`(`lastInboundAt`),
    INDEX `Conversation_userId_idx`(`userId`),
    INDEX `Conversation_campaignId_idx`(`campaignId`),
    INDEX `Conversation_unipileChatId_idx`(`unipileChatId`),
    UNIQUE INDEX `Conversation_leadId_channel_key`(`leadId`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UsageLog` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `campaignId` VARCHAR(191) NULL,
    `provider` ENUM('SPARIOR', 'APIFY', 'GEMINI', 'ZAPIER', 'OTHER') NOT NULL,
    `operation` VARCHAR(191) NOT NULL,
    `requestCount` INTEGER NOT NULL DEFAULT 1,
    `itemsReturned` INTEGER NULL,
    `inputTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `estimatedCostUsd` DECIMAL(12, 6) NULL,
    `quotaRemaining` INTEGER NULL,
    `metadata` JSON NULL,
    `scrapeJobId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UsageLog_provider_createdAt_idx`(`provider`, `createdAt`),
    INDEX `UsageLog_campaignId_createdAt_idx`(`campaignId`, `createdAt`),
    INDEX `UsageLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `UsageLog_scrapeJobId_idx`(`scrapeJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CompanyProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `description` TEXT NULL,
    `services` JSON NULL,
    `targetIndustries` JSON NULL,
    `targetCountries` JSON NULL,
    `idealCustomerProfile` TEXT NULL,
    `brandTone` VARCHAR(191) NULL,
    `messageLanguage` VARCHAR(191) NOT NULL DEFAULT 'en',
    `preferredLength` JSON NULL,
    `ctaStyle` VARCHAR(191) NULL,
    `forbiddenClaims` JSON NULL,
    `pricingPolicy` TEXT NULL,
    `exampleMessages` JSON NULL,
    `objectionNotes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CompanyProfile_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MessageDraft` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `subject` VARCHAR(255) NULL,
    `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL DEFAULT 'INSTAGRAM',
    `kind` ENUM('OUTREACH', 'REPLY') NOT NULL DEFAULT 'OUTREACH',
    `replyToMessageId` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'SENT', 'PENDING_REVIEW', 'BLOCKED') NOT NULL DEFAULT 'DRAFT',
    `promptVersion` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `personalizationPointsUsed` JSON NULL,
    `generationMeta` JSON NULL,
    `wordCount` INTEGER NOT NULL,
    `qualityVersion` VARCHAR(191) NULL,
    `qualityScore` INTEGER NULL,
    `qualityPassed` BOOLEAN NULL,
    `qualityResult` JSON NULL,
    `qualityCheckedAt` DATETIME(3) NULL,
    `regenerationCount` INTEGER NOT NULL DEFAULT 0,
    `editedBody` LONGTEXT NULL,
    `bodyHash` VARCHAR(64) NULL,
    `approvedBodyHash` VARCHAR(64) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedByType` VARCHAR(191) NULL,
    `approvedById` VARCHAR(191) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectReasonCode` VARCHAR(191) NULL,
    `rejectNotes` TEXT NULL,
    `editDistance` INTEGER NULL,
    `warningOverrides` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MessageDraft_leadId_createdAt_idx`(`leadId`, `createdAt`),
    INDEX `MessageDraft_campaignId_status_idx`(`campaignId`, `status`),
    INDEX `MessageDraft_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `MessageDraft_qualityPassed_idx`(`qualityPassed`),
    INDEX `MessageDraft_kind_idx`(`kind`),
    INDEX `MessageDraft_replyToMessageId_idx`(`replyToMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DraftReview` (
    `id` VARCHAR(191) NOT NULL,
    `draftId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `actorType` VARCHAR(191) NOT NULL,
    `action` ENUM('APPROVE', 'REJECT', 'EDIT', 'REGENERATE', 'RECHECK', 'OVERRIDE_WARNING', 'AUTO_APPROVE', 'REVOKE_APPROVAL') NOT NULL,
    `reasonCode` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `meta` JSON NULL,
    `bodyHashBefore` VARCHAR(191) NULL,
    `bodyHashAfter` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DraftReview_draftId_createdAt_idx`(`draftId`, `createdAt`),
    INDEX `DraftReview_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiAnalysisJob` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED') NOT NULL DEFAULT 'PENDING',
    `total` INTEGER NOT NULL DEFAULT 0,
    `processed` INTEGER NOT NULL DEFAULT 0,
    `succeeded` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `skipped` INTEGER NOT NULL DEFAULT 0,
    `cancelRequested` BOOLEAN NOT NULL DEFAULT false,
    `options` JSON NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `lastError` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiAnalysisJob_campaignId_createdAt_idx`(`campaignId`, `createdAt`),
    INDEX `AiAnalysisJob_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UnipileWebhookEvent` (
    `id` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `unipileEventId` VARCHAR(191) NULL,
    `rawPayloadHash` VARCHAR(64) NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `status` ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `failReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `UnipileWebhookEvent_unipileEventId_key`(`unipileEventId`),
    INDEX `UnipileWebhookEvent_rawPayloadHash_idx`(`rawPayloadHash`),
    INDEX `UnipileWebhookEvent_eventType_status_idx`(`eventType`, `status`),
    INDEX `UnipileWebhookEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UnmatchedInboundMessage` (
    `id` VARCHAR(191) NOT NULL,
    `unipileAccountId` VARCHAR(191) NOT NULL,
    `unipileMessageId` VARCHAR(191) NULL,
    `unipileChatId` VARCHAR(191) NULL,
    `providerSenderId` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NULL,
    `text` LONGTEXT NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `linkedLeadId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UnmatchedInboundMessage_unipileMessageId_key`(`unipileMessageId`),
    INDEX `UnmatchedInboundMessage_unipileAccountId_idx`(`unipileAccountId`),
    INDEX `UnmatchedInboundMessage_providerSenderId_idx`(`providerSenderId`),
    INDEX `UnmatchedInboundMessage_username_idx`(`username`),
    INDEX `UnmatchedInboundMessage_linkedLeadId_idx`(`linkedLeadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationConfig` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `ntfyTopic` VARCHAR(191) NOT NULL,
    `ntfyServerUrl` VARCHAR(191) NOT NULL DEFAULT 'https://ntfy.sh',
    `ntfyAccessToken` LONGTEXT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `eventTypes` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NotificationConfig_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationLog` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `eventType` ENUM('LEAD_REPLIED', 'HIGH_VALUE_LEAD', 'SENDER_ERROR', 'SESSION_EXPIRED', 'SYSTEM_ERROR', 'DAILY_SUMMARY') NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `status` ENUM('SENT', 'FAILED', 'SKIPPED_DISABLED') NOT NULL,
    `errorReason` TEXT NULL,
    `latencyMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NotificationLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `NotificationLog_eventType_createdAt_idx`(`eventType`, `createdAt`),
    INDEX `NotificationLog_leadId_idx`(`leadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadEvent` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `eventType` ENUM('SENT', 'DELIVERED', 'REPLIED', 'POSITIVE_REPLY', 'NEGATIVE_REPLY', 'UNSUBSCRIBE_OR_DNC', 'MEETING_BOOKED', 'WON') NOT NULL,
    `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL DEFAULT 'INSTAGRAM',
    `messageId` VARCHAR(191) NULL,
    `variant` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `actor` VARCHAR(191) NOT NULL DEFAULT 'system',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LeadEvent_leadId_createdAt_idx`(`leadId`, `createdAt`),
    INDEX `LeadEvent_campaignId_eventType_idx`(`campaignId`, `eventType`),
    INDEX `LeadEvent_campaignId_createdAt_idx`(`campaignId`, `createdAt`),
    INDEX `LeadEvent_eventType_createdAt_idx`(`eventType`, `createdAt`),
    INDEX `LeadEvent_campaignId_variant_idx`(`campaignId`, `variant`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FollowUpMessage` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `step` INTEGER NOT NULL,
    `status` ENUM('SCHEDULED', 'SENT', 'CANCELLED_REPLIED', 'CANCELLED_DNC', 'CANCELLED_MANUAL', 'NEEDS_EDIT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'SCHEDULED',
    `templateText` TEXT NOT NULL,
    `renderedBody` LONGTEXT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `retryAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `threadId` VARCHAR(191) NULL,
    `messageId` VARCHAR(191) NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FollowUpMessage_idempotencyKey_key`(`idempotencyKey`),
    INDEX `FollowUpMessage_status_dueAt_idx`(`status`, `dueAt`),
    INDEX `FollowUpMessage_campaignId_status_idx`(`campaignId`, `status`),
    INDEX `FollowUpMessage_leadId_idx`(`leadId`),
    UNIQUE INDEX `FollowUpMessage_campaignId_leadId_step_key`(`campaignId`, `leadId`, `step`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Campaign` ADD CONSTRAINT `Campaign_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Campaign` ADD CONSTRAINT `Campaign_companyProfileId_fkey` FOREIGN KEY (`companyProfileId`) REFERENCES `CompanyProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_scrapeJobId_fkey` FOREIGN KEY (`scrapeJobId`) REFERENCES `ScrapeJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_duplicateOfLeadId_fkey` FOREIGN KEY (`duplicateOfLeadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_possibleDuplicateOfLeadId_fkey` FOREIGN KEY (`possibleDuplicateOfLeadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadScoreFlag` ADD CONSTRAINT `LeadScoreFlag_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadSighting` ADD CONSTRAINT `LeadSighting_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadSighting` ADD CONSTRAINT `LeadSighting_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScrapeJob` ADD CONSTRAINT `ScrapeJob_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Candidate` ADD CONSTRAINT `Candidate_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Candidate` ADD CONSTRAINT `Candidate_scrapeJobId_fkey` FOREIGN KEY (`scrapeJobId`) REFERENCES `ScrapeJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailSenderAccount` ADD CONSTRAINT `EmailSenderAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailCampaignSettings` ADD CONSTRAINT `EmailCampaignSettings_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailSend` ADD CONSTRAINT `EmailSend_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailSend` ADD CONSTRAINT `EmailSend_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailSend` ADD CONSTRAINT `EmailSend_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `EmailSenderAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailUnsubscribeToken` ADD CONSTRAINT `EmailUnsubscribeToken_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_draftId_fkey` FOREIGN KEY (`draftId`) REFERENCES `MessageDraft`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageTemplate` ADD CONSTRAINT `MessageTemplate_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InstagramSenderAccount` ADD CONSTRAINT `InstagramSenderAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OutboundSendIdempotency` ADD CONSTRAINT `OutboundSendIdempotency_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignExecution` ADD CONSTRAINT `CampaignExecution_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignExecution` ADD CONSTRAINT `CampaignExecution_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignExecution` ADD CONSTRAINT `CampaignExecution_scrapeJobId_fkey` FOREIGN KEY (`scrapeJobId`) REFERENCES `ScrapeJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignExecution` ADD CONSTRAINT `CampaignExecution_bulkMessageJobId_fkey` FOREIGN KEY (`bulkMessageJobId`) REFERENCES `BulkMessageJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignExecutionItem` ADD CONSTRAINT `CampaignExecutionItem_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `CampaignExecution`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignExecutionItem` ADD CONSTRAINT `CampaignExecutionItem_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageJob` ADD CONSTRAINT `BulkMessageJob_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageJob` ADD CONSTRAINT `BulkMessageJob_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageJob` ADD CONSTRAINT `BulkMessageJob_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `MessageTemplate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageJob` ADD CONSTRAINT `BulkMessageJob_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageItem` ADD CONSTRAINT `BulkMessageItem_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `BulkMessageJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageItem` ADD CONSTRAINT `BulkMessageItem_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `BulkMessageJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `BulkMessageItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageAttempt` ADD CONSTRAINT `MessageAttempt_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadStatusHistory` ADD CONSTRAINT `LeadStatusHistory_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DoNotContact` ADD CONSTRAINT `DoNotContact_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Conversation` ADD CONSTRAINT `Conversation_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UsageLog` ADD CONSTRAINT `UsageLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UsageLog` ADD CONSTRAINT `UsageLog_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CompanyProfile` ADD CONSTRAINT `CompanyProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageDraft` ADD CONSTRAINT `MessageDraft_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageDraft` ADD CONSTRAINT `MessageDraft_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageDraft` ADD CONSTRAINT `MessageDraft_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MessageDraft` ADD CONSTRAINT `MessageDraft_replyToMessageId_fkey` FOREIGN KEY (`replyToMessageId`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DraftReview` ADD CONSTRAINT `DraftReview_draftId_fkey` FOREIGN KEY (`draftId`) REFERENCES `MessageDraft`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DraftReview` ADD CONSTRAINT `DraftReview_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiAnalysisJob` ADD CONSTRAINT `AiAnalysisJob_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiAnalysisJob` ADD CONSTRAINT `AiAnalysisJob_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotificationConfig` ADD CONSTRAINT `NotificationConfig_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotificationLog` ADD CONSTRAINT `NotificationLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadEvent` ADD CONSTRAINT `LeadEvent_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadEvent` ADD CONSTRAINT `LeadEvent_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadEvent` ADD CONSTRAINT `LeadEvent_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FollowUpMessage` ADD CONSTRAINT `FollowUpMessage_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FollowUpMessage` ADD CONSTRAINT `FollowUpMessage_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FollowUpMessage` ADD CONSTRAINT `FollowUpMessage_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
