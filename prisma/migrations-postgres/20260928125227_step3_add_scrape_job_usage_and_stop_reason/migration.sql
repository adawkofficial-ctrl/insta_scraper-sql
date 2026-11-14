-- AlterTable
ALTER TABLE "ScrapeJob" ADD COLUMN     "stopReason" TEXT,
ADD COLUMN     "usage" JSONB;
