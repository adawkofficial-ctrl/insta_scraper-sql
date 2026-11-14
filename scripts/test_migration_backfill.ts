import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const prisma = createPrismaClient();

async function run() {
  console.log("=== PRE-MIGRATION COUNTS ===");
  const totalCampaigns = await prisma.campaign.count();
  const nullCampaignsPre = await prisma.campaign.count({ where: { companyProfileId: null as any } });
  const totalProfilesPre = await prisma.companyProfile.count();
  console.log({ totalCampaigns, nullCampaignsPre, totalProfilesPre });

  console.log("\n=== RUNNING BACKFILL QUERIES ===");
  // 1. Drop unique constraint if exists
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "CompanyProfile_userId_key";`);

  // 2. Add isDefault column
  await prisma.$executeRawUnsafe(`ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;`);

  // 3. Mark existing profiles as default
  await prisma.$executeRawUnsafe(`UPDATE "CompanyProfile" SET "isDefault" = true WHERE "isDefault" = false;`);

  // 4. Create default profiles for users who have campaigns without a profile
  const insertedProfiles = await prisma.$executeRawUnsafe(`
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
  `);
  console.log(`Inserted default profiles for users without profile: ${insertedProfiles}`);

  // 5. Backfill campaigns
  const updatedCampaigns = await prisma.$executeRawUnsafe(`
    UPDATE "Campaign" c
    SET "companyProfileId" = p."id"
    FROM (
      SELECT DISTINCT ON ("userId") "id", "userId"
      FROM "CompanyProfile"
      ORDER BY "userId", "isDefault" DESC, "createdAt" ASC
    ) p
    WHERE c."userId" = p."userId" AND c."companyProfileId" IS NULL;
  `);
  console.log(`Updated campaigns with companyProfileId: ${updatedCampaigns}`);

  // 6. Set NOT NULL and foreign key constraint
  const nullCampaignsPost = await prisma.campaign.count({ where: { companyProfileId: null as any } });
  const totalProfilesPost = await prisma.companyProfile.count();
  console.log("\n=== POST-BACKFILL CHECK ===");
  console.log({ totalCampaigns, nullCampaignsPost, totalProfilesPost });

  if (nullCampaignsPost > 0) {
    throw new Error(`Cannot set NOT NULL: ${nullCampaignsPost} campaigns still have null companyProfileId`);
  }

  await prisma.$executeRawUnsafe(`ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_companyProfileId_fkey";`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Campaign" ALTER COLUMN "companyProfileId" SET NOT NULL;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_companyProfileId_fkey" FOREIGN KEY ("companyProfileId") REFERENCES "CompanyProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CompanyProfile_userId_idx" ON "CompanyProfile"("userId");`);

  console.log("Migration executed successfully!");
}

run()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
