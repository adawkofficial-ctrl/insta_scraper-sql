-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "businessCategoryName" TEXT,
ADD COLUMN     "followersCount" INTEGER,
ADD COLUMN     "followsCount" INTEGER,
ADD COLUMN     "isBusinessAccount" BOOLEAN,
ADD COLUMN     "profilePicUrl" TEXT,
ADD COLUMN     "profilePicUrlHD" TEXT,
ADD COLUMN     "rawProfileData" JSONB,
ADD COLUMN     "verified" BOOLEAN;

-- CreateIndex
CREATE INDEX "Lead_fullName_idx" ON "Lead"("fullName");

-- CreateIndex
CREATE INDEX "Lead_category_idx" ON "Lead"("category");
