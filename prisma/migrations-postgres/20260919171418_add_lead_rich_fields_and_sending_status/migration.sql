-- AlterEnum
ALTER TYPE "ExecutionItemStatus" ADD VALUE 'SENDING';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "instagramId" TEXT,
ADD COLUMN     "latestPosts" JSONB,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "relatedProfiles" JSONB;
