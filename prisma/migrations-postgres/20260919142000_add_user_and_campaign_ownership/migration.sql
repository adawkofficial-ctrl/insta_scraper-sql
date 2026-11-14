-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- Create Default Development User to preserve existing development data
INSERT INTO "User" ("id", "email", "passwordHash", "name", "createdAt", "updatedAt")
VALUES ('dev_default_user_001', 'dev@instascraper.local', '$2b$10$PtDa3LMLE/D5zPDZM60vsevc5IQruUdygbVGxbgQxTYPzm6wJSv9a', 'Development Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- AlterTable Campaign: Add userId column as nullable first
ALTER TABLE "Campaign" ADD COLUMN "userId" TEXT;

-- Assign all existing campaigns to the development user
UPDATE "Campaign" SET "userId" = 'dev_default_user_001' WHERE "userId" IS NULL;

-- Make userId NOT NULL now that all rows are populated
ALTER TABLE "Campaign" ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Campaign_userId_idx" ON "Campaign"("userId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
