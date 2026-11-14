-- Phase 4 ETL: widen source values that exceed the default VARCHAR(191).
ALTER TABLE `Lead` MODIFY COLUMN `socialLink` VARCHAR(512) NULL;
ALTER TABLE `ScrapeJob` MODIFY COLUMN `query` VARCHAR(255) NULL;
