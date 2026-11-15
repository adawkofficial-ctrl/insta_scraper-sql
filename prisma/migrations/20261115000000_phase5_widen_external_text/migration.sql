-- AlterTable
ALTER TABLE `AiAnalysisJob` MODIFY `lastError` TEXT NULL;

-- AlterTable
ALTER TABLE `Campaign` MODIFY `category` TEXT NULL;

-- AlterTable
ALTER TABLE `CampaignExecutionItem` MODIFY `messageText` TEXT NOT NULL,
    MODIFY `errorMessage` TEXT NULL;

-- AlterTable
ALTER TABLE `Candidate` MODIFY `category` TEXT NULL,
    MODIFY `mapsUrl` TEXT NULL,
    MODIFY `rejectionReason` TEXT NULL,
    MODIFY `lastError` TEXT NULL;

-- AlterTable
ALTER TABLE `CompanyProfile` MODIFY `name` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `DraftReview` MODIFY `notes` TEXT NULL;

-- AlterTable
ALTER TABLE `EmailSend` MODIFY `subject` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `EmailSenderAccount` MODIFY `postalAddress` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `InstagramSenderAccount` MODIFY `displayName` TEXT NULL;

-- AlterTable
ALTER TABLE `Lead` MODIFY `profilePictureUrl` TEXT NULL,
    MODIFY `profilePicUrl` TEXT NULL,
    MODIFY `profilePicUrlHD` TEXT NULL,
    MODIFY `possibleDuplicateReason` TEXT NULL;

-- AlterTable
ALTER TABLE `MessageDraft` MODIFY `subject` TEXT NULL;

-- AlterTable
ALTER TABLE `MessageTemplate` MODIFY `name` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `NotificationConfig` MODIFY `ntfyTopic` TEXT NOT NULL,
    MODIFY `ntfyServerUrl` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `OutboundSendIdempotency` MODIFY `errorMessage` TEXT NULL;

-- AlterTable
ALTER TABLE `ScrapeJob` MODIFY `query` TEXT NULL,
    MODIFY `location` TEXT NULL,
    MODIFY `category` TEXT NULL;

-- AlterTable
ALTER TABLE `User` MODIFY `name` TEXT NULL,
    MODIFY `image` TEXT NULL;
