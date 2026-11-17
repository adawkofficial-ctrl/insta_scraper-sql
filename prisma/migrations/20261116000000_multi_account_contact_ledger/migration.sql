-- AlterTable
ALTER TABLE `BulkMessageItem` ADD COLUMN `senderAccountId` VARCHAR(191) NULL,
    ADD COLUMN `templateId` VARCHAR(191) NULL,
    ADD COLUMN `variant` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `Campaign` ADD COLUMN `allowNeutralGreeting` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `followUpAllowSenderSwitch` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `reContactCooldownDays` INTEGER NULL,
    ADD COLUMN `requireNameInFirstMessage` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `FollowUpMessage` ADD COLUMN `renderedTextHash` VARCHAR(64) NULL,
    ADD COLUMN `senderUsernameSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `templateId` VARCHAR(191) NULL,
    ADD COLUMN `variant` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `InstagramSenderAccount` ADD COLUMN `scheduleOffsetSeconds` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `settingsUpdatedAt` DATETIME(3) NULL,
    ADD COLUMN `warmupEnabled` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `Lead` ADD COLUMN `assignedSenderAccountId` VARCHAR(191) NULL,
    ADD COLUMN `contactedByUsernameSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `firstContactedAt` DATETIME(3) NULL,
    ADD COLUMN `firstContactedBySenderId` VARCHAR(191) NULL,
    ADD COLUMN `outreachCount` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `Message` ADD COLUMN `renderedTextHash` VARCHAR(64) NULL,
    ADD COLUMN `scheduledAt` DATETIME(3) NULL,
    ADD COLUMN `senderUsernameSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `step` VARCHAR(32) NULL,
    ADD COLUMN `templateId` VARCHAR(191) NULL,
    ADD COLUMN `threadId` VARCHAR(191) NULL,
    ADD COLUMN `variant` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `MessageAttempt` ADD COLUMN `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL DEFAULT 'INSTAGRAM',
    ADD COLUMN `renderedTextHash` VARCHAR(64) NULL,
    ADD COLUMN `scheduledAt` DATETIME(3) NULL,
    ADD COLUMN `senderUsernameSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `step` VARCHAR(32) NULL,
    ADD COLUMN `templateId` VARCHAR(191) NULL,
    ADD COLUMN `threadId` VARCHAR(191) NULL,
    ADD COLUMN `variant` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `LeadContactLedger` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `handle` VARCHAR(191) NOT NULL,
    `handleNormalized` VARCHAR(191) NOT NULL,
    `instagramUserId` VARCHAR(191) NULL,
    `step` VARCHAR(32) NOT NULL DEFAULT '1',
    `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL DEFAULT 'INSTAGRAM',
    `status` VARCHAR(32) NOT NULL DEFAULT 'RESERVED',
    `reason` VARCHAR(64) NULL,
    `templateId` VARCHAR(191) NULL,
    `variant` VARCHAR(64) NULL,
    `renderedTextHash` VARCHAR(64) NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `threadId` VARCHAR(191) NULL,
    `senderUsernameSnapshot` VARCHAR(191) NULL,
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LeadContactLedger_leadId_idx`(`leadId`),
    INDEX `LeadContactLedger_campaignId_idx`(`campaignId`),
    INDEX `LeadContactLedger_senderAccountId_idx`(`senderAccountId`),
    INDEX `LeadContactLedger_status_idx`(`status`),
    INDEX `LeadContactLedger_reservedAt_idx`(`reservedAt`),
    UNIQUE INDEX `LeadContactLedger_userId_handleNormalized_step_channel_key`(`userId`, `handleNormalized`, `step`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadContactEvent` (
    `id` VARCHAR(191) NOT NULL,
    `ledgerId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `senderUsernameSnapshot` VARCHAR(191) NULL,
    `step` VARCHAR(32) NOT NULL,
    `channel` ENUM('INSTAGRAM', 'EMAIL') NOT NULL DEFAULT 'INSTAGRAM',
    `status` VARCHAR(32) NOT NULL,
    `reason` VARCHAR(64) NULL,
    `templateId` VARCHAR(191) NULL,
    `variant` VARCHAR(64) NULL,
    `renderedTextHash` VARCHAR(64) NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `threadId` VARCHAR(191) NULL,
    `scheduledAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LeadContactEvent_leadId_createdAt_idx`(`leadId`, `createdAt`),
    INDEX `LeadContactEvent_campaignId_createdAt_idx`(`campaignId`, `createdAt`),
    INDEX `LeadContactEvent_senderAccountId_createdAt_idx`(`senderAccountId`, `createdAt`),
    INDEX `LeadContactEvent_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SenderSettingsAudit` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `senderAccountId` VARCHAR(191) NULL,
    `actorUserId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `oldValues` JSON NULL,
    `newValues` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SenderSettingsAudit_senderAccountId_createdAt_idx`(`senderAccountId`, `createdAt`),
    INDEX `SenderSettingsAudit_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Lead_assignedSenderAccountId_idx` ON `Lead`(`assignedSenderAccountId`);

-- CreateIndex
CREATE INDEX `Lead_firstContactedBySenderId_idx` ON `Lead`(`firstContactedBySenderId`);

-- CreateIndex
CREATE INDEX `Lead_firstContactedAt_idx` ON `Lead`(`firstContactedAt`);

-- CreateIndex
CREATE INDEX `Lead_lastContactedAt_idx` ON `Lead`(`lastContactedAt`);

-- CreateIndex
CREATE INDEX `Lead_contactedByUsernameSnapshot_idx` ON `Lead`(`contactedByUsernameSnapshot`);

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_assignedSenderAccountId_fkey` FOREIGN KEY (`assignedSenderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_firstContactedBySenderId_fkey` FOREIGN KEY (`firstContactedBySenderId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BulkMessageItem` ADD CONSTRAINT `BulkMessageItem_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactLedger` ADD CONSTRAINT `LeadContactLedger_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactLedger` ADD CONSTRAINT `LeadContactLedger_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactLedger` ADD CONSTRAINT `LeadContactLedger_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactLedger` ADD CONSTRAINT `LeadContactLedger_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactEvent` ADD CONSTRAINT `LeadContactEvent_ledgerId_fkey` FOREIGN KEY (`ledgerId`) REFERENCES `LeadContactLedger`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactEvent` ADD CONSTRAINT `LeadContactEvent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactEvent` ADD CONSTRAINT `LeadContactEvent_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactEvent` ADD CONSTRAINT `LeadContactEvent_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadContactEvent` ADD CONSTRAINT `LeadContactEvent_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SenderSettingsAudit` ADD CONSTRAINT `SenderSettingsAudit_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SenderSettingsAudit` ADD CONSTRAINT `SenderSettingsAudit_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `InstagramSenderAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

