-- Step Company Profile Per Campaign Migration

-- 1. Drop unique constraint on CompanyProfile(userId)
DROP INDEX IF EXISTS "CompanyProfile_userId_key";

-- 2. Add isDefault column to CompanyProfile
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- 3. Mark any existing profiles as default
UPDATE "CompanyProfile" SET "isDefault" = true WHERE "isDefault" = false;

-- 4. Backfill default CompanyProfile for users who have campaigns without a profile
INSERT INTO "CompanyProfile" ("id", "userId", "name", "isDefault", "description", "services", "targetIndustries", "targetCountries", "messageLanguage", "forbiddenClaims", "createdAt", "updatedAt")
SELECT
  'cp_' || substr(md5(random()::text || clock_timestamp()::text || u."userId"), 1, 22),
  u."userId",
  'Default Profile',
  true,
  '',
  '[]'::jsonb,
  '{}'::text[],
  '{}'::text[],
  'en',
  '{}'::text[],
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT "userId" FROM "Campaign"
  WHERE "companyProfileId" IS NULL
  AND "userId" NOT IN (SELECT "userId" FROM "CompanyProfile")
) u;

-- 5. Backfill campaigns to attach their user's CompanyProfile
UPDATE "Campaign" c
SET "companyProfileId" = p."id"
FROM (
  SELECT DISTINCT ON ("userId") "id", "userId"
  FROM "CompanyProfile"
  ORDER BY "userId", "isDefault" DESC, "createdAt" ASC
) p
WHERE c."userId" = p."userId" AND c."companyProfileId" IS NULL;

-- 6. Update Campaign.companyProfileId to NOT NULL with ON DELETE RESTRICT
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_companyProfileId_fkey";
ALTER TABLE "Campaign" ALTER COLUMN "companyProfileId" SET NOT NULL;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_companyProfileId_fkey" FOREIGN KEY ("companyProfileId") REFERENCES "CompanyProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Ensure index on CompanyProfile(userId)
CREATE INDEX IF NOT EXISTS "CompanyProfile_userId_idx" ON "CompanyProfile"("userId");
