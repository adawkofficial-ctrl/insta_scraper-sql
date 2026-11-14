-- Phase 3 performance indexes for the campaign lead list filters.
CREATE INDEX `Lead_campaignId_createdAt_idx` ON `Lead` (`campaignId`, `createdAt`);
CREATE INDEX `Lead_campaignId_hasInstagram_createdAt_idx` ON `Lead` (`campaignId`, `hasInstagram`, `createdAt`);
CREATE INDEX `Lead_campaignId_hasEmail_createdAt_idx` ON `Lead` (`campaignId`, `hasEmail`, `createdAt`);
CREATE INDEX `Lead_campaignId_hasWebsite_createdAt_idx` ON `Lead` (`campaignId`, `hasWebsite`, `createdAt`);
