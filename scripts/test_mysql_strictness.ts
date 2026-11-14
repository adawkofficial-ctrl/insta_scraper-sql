/**
 * MySQL Phase 2 strictness tests.
 * Proves STRICT_ALL_TABLES prevents silent truncation for VARCHAR and TEXT.
 */
import "dotenv/config";
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase } = require("./test_db_guard.cjs");
const testDatabaseUrl = getTestDatabaseUrl();
assertSafeTestDatabase(testDatabaseUrl, { throwOnError: true });
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_MYSQL_LOCAL = testDatabaseUrl;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { getPrismaClient } from "../src/lib/db/prisma";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

function isTooLongError(err: unknown): boolean {
  const record = err as { code?: string; message?: string };
  return (
    record?.code === "P2000" ||
    /too long|data too long|out of range/i.test(record?.message ?? "")
  );
}

async function main() {
  console.log("=== MYSQL STRICTNESS TESTS ===");
  const prisma = getPrismaClient();
  const tag = `strict_${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "Strict Test", passwordHash: "x" },
  });
  const profile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Strict Co" },
  });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, companyProfileId: profile.id, name: `${tag} campaign` },
  });

  try {
    let varcharRejected = false;
    try {
      await prisma.lead.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          fullName: "Too Long City",
          city: "x".repeat(200),
        },
      });
    } catch (err) {
      varcharRejected = isTooLongError(err);
    }
    check(varcharRejected, "VARCHAR(191) over-length write errors (no silent truncation)");

    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Strict Lead",
      },
    });

    let textRejected = false;
    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { description: "x".repeat(70_000) },
      });
    } catch (err) {
      textRejected = isTooLongError(err);
    }
    check(textRejected, "TEXT over 65,535 bytes errors in strict mode");

    const template = await prisma.messageTemplate.create({
      data: {
        campaignId: campaign.id,
        name: "Long Body",
        body: "y".repeat(70_000),
      },
    });
    check(
      template.body.length === 70_000,
      "LONGTEXT accepts a 70,000-character body without truncation",
      String(template.body.length),
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log("\n=======================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error("Strictness test threw:", err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
