import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const prisma = createPrismaClient();

async function main() {
  const users = await prisma.user.count();
  const campaigns = await prisma.campaign.count();
  const profiles = await prisma.companyProfile.count();
  const rawNullCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) as count FROM "Campaign" WHERE "companyProfileId" IS NULL;
  `;
  const nullCampaigns = Number(rawNullCount[0].count);
  console.log("SUMMARY:", { users, campaigns, profiles, nullCampaigns });
}

main().finally(() => prisma.$disconnect());
