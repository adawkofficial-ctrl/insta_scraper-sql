-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "availableChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "contactSource" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneNormalized" TEXT;

-- CreateIndex
CREATE INDEX "Lead_phoneNormalized_idx" ON "Lead"("phoneNormalized");
