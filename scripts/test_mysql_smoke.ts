/**
 * Minimal MySQL smoke test (Phase 1 only).
 * Connects to the local MySQL test DB, creates a user/campaign/lead, reads it
 * back, and cleans up. No Apify/Gemini/Unipile calls.
 */
import "dotenv/config";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase, extractDatabaseName } = require("./test_db_guard.cjs");
const testDatabaseUrl = getTestDatabaseUrl();
assertSafeTestDatabase(testDatabaseUrl, { throwOnError: true });
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_MYSQL_LOCAL = testDatabaseUrl;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { createPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const parsed = new URL(testDatabaseUrl);
  console.log(`MySQL smoke test -> host=${parsed.hostname}:${parsed.port || "3306"} db=${extractDatabaseName(testDatabaseUrl)}`);

  const prisma = createPrismaClient();
  const tag = `mysql_smoke_${Date.now()}`;
  let userId: string | null = null;

  try {
    const user = await prisma.user.create({
      data: {
        email: `${tag}@example.com`,
        name: "MySQL Smoke Test",
        passwordHash: "smoke-test-hash",
      },
    });
    userId = user.id;

    const profile = await prisma.companyProfile.create({
      data: { userId: user.id, name: "MySQL Smoke Co" },
    });

    const campaign = await prisma.campaign.create({
      data: {
        userId: user.id,
        companyProfileId: profile.id,
        name: `${tag} campaign`,
        location: "Toronto, ON",
        leadLimit: 10,
      },
    });

    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Smoke Test Lead",
        username: "smoke_test_lead",
        instagramUsername: "smoke_test_lead",
        email: `${tag}_lead@example.com`,
      },
    });

    const readBack = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
      select: { id: true, fullName: true, username: true, campaignId: true },
    });

    if (readBack.id !== lead.id || readBack.campaignId !== campaign.id || readBack.username !== "smoke_test_lead") {
      throw new Error("Smoke test read-back mismatch.");
    }

    console.log("PASS: created user/companyProfile/campaign/lead and read the lead back");
    console.log(`PASS: database=${extractDatabaseName(testDatabaseUrl)} tables reachable`);

    await prisma.user.delete({ where: { id: user.id } });
    userId = null;
    console.log("PASS: cleanup deleted the user (cascade)");
  } finally {
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("MySQL smoke test FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
